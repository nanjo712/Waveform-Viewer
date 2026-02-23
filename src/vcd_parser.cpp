#include "vcd_parser.h"

#ifndef __EMSCRIPTEN__
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#include <algorithm>
#include <cassert>
#include <cerrno>
#include <cstring>
#include <stdexcept>

namespace vcd
{

    // ============================================================================
    // Helper: lightweight zero-copy scanner over mmap'd memory
    // ============================================================================

    class Scanner
    {
       public:
        Scanner() : cur_(nullptr), end_(nullptr) {}
        Scanner(const char* begin, const char* end) : cur_(begin), end_(end) {}

        bool eof() const { return cur_ >= end_; }
        size_t remaining() const
        {
            return eof() ? 0 : static_cast<size_t>(end_ - cur_);
        }
        const char* pos() const { return cur_; }
        const char* end_pos() const { return end_; }
        size_t offset(const char* base) const
        {
            return static_cast<size_t>(cur_ - base);
        }

        void set_pos(const char* p) { cur_ = p; }
        void advance(size_t n) { cur_ += n; }

        void skip_ws()
        {
            while (cur_ < end_ && (*cur_ == ' ' || *cur_ == '\t' ||
                                   *cur_ == '\n' || *cur_ == '\r'))
                ++cur_;
        }

        void skip_line()
        {
            while (cur_ < end_ && *cur_ != '\n') ++cur_;
            if (cur_ < end_) ++cur_;
        }

        std::string_view next_token()
        {
            skip_ws();
            const char* start = cur_;
            while (cur_ < end_ && *cur_ != ' ' && *cur_ != '\t' &&
                   *cur_ != '\n' && *cur_ != '\r')
                ++cur_;
            return {start, static_cast<size_t>(cur_ - start)};
        }

        std::string_view rest_of_line()
        {
            while (cur_ < end_ && (*cur_ == ' ' || *cur_ == '\t')) ++cur_;
            const char* start = cur_;
            while (cur_ < end_ && *cur_ != '\n' && *cur_ != '\r') ++cur_;
            const char* le = cur_;
            while (le > start && (*(le - 1) == ' ' || *(le - 1) == '\t')) --le;
            if (cur_ < end_ && *cur_ == '\r') ++cur_;
            if (cur_ < end_ && *cur_ == '\n') ++cur_;
            return {start, static_cast<size_t>(le - start)};
        }

        std::string_view read_until_end()
        {
            const char* start = cur_;
            while (cur_ < end_)
            {
                skip_ws();
                auto tok = next_token();
                if (tok == "$end")
                {
                    return {start, static_cast<size_t>(cur_ - start)};
                }
            }
            return {start, static_cast<size_t>(cur_ - start)};
        }

        bool skip_until(std::string_view keyword)
        {
            while (!eof())
            {
                skip_ws();
                if (eof()) return false;
                auto tok = next_token();
                if (tok == keyword) return true;
            }
            return false;
        }

        char peek() const
        {
            const char* p = cur_;
            while (p < end_ &&
                   (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r'))
                ++p;
            return (p < end_) ? *p : '\0';
        }

        std::string_view read_line()
        {
            const char* start = cur_;
            while (cur_ < end_ && *cur_ != '\n') ++cur_;
            const char* le = cur_;
            if (cur_ < end_) ++cur_;
            if (le > start && *(le - 1) == '\r') --le;
            return {start, static_cast<size_t>(le - start)};
        }

       private:
        const char* cur_;
        const char* end_;
    };

    // ============================================================================
    // VcdParser::Impl
    // ============================================================================

    struct VcdParser::Impl
    {
        // --- Data source ---
        const char* data = nullptr;
        size_t file_sz = 0;
        bool owns_mapping = false;  // true if mmap'd (native only)
#ifndef __EMSCRIPTEN__
        int fd = -1;
#endif

        // --- Header metadata ---
        std::string date_str;
        std::string version_str;
        Timescale ts;

        // --- Signal definitions ---
        std::vector<SignalDef> signal_defs;
        std::unordered_map<std::string, std::vector<uint32_t>> id_to_index;
        std::unordered_map<std::string, uint32_t> path_to_index;

        // --- Hierarchy ---
        std::unique_ptr<ScopeNode> root;

        // --- Value-change section ---
        size_t vc_offset = 0;
        uint64_t t_begin = 0;
        uint64_t t_end = 0;

        // --- Per-signal transitions ---
        std::vector<SignalTransitions> sig_transitions;

        // --- Chunk snapshots ---
        uint64_t chunk_size = 10000;
        std::vector<ChunkSnapshot> snapshots;

        // --- Initial values from $dumpvars ---
        std::vector<std::string> init_vals;

        // ================================================================
        // Data source management
        // ================================================================

#ifndef __EMSCRIPTEN__
        bool map_file(const std::string& path)
        {
            fd = ::open(path.c_str(), O_RDONLY);
            if (fd < 0) return false;

            struct stat st
            {
            };
            if (::fstat(fd, &st) != 0)
            {
                ::close(fd);
                fd = -1;
                return false;
            }
            file_sz = static_cast<size_t>(st.st_size);
            if (file_sz == 0)
            {
                ::close(fd);
                fd = -1;
                return false;
            }

            data = static_cast<const char*>(
                ::mmap(nullptr, file_sz, PROT_READ, MAP_PRIVATE, fd, 0));
            if (data == MAP_FAILED)
            {
                data = nullptr;
                ::close(fd);
                fd = -1;
                return false;
            }

            ::madvise(const_cast<char*>(data), file_sz, MADV_SEQUENTIAL);
            owns_mapping = true;
            return true;
        }
#endif

        bool load_buffer(const char* buf, size_t size)
        {
            if (!buf || size == 0) return false;
            data = buf;
            file_sz = size;
            owns_mapping = false;
            return true;
        }

        void release_data()
        {
#ifndef __EMSCRIPTEN__
            if (owns_mapping && data && data != MAP_FAILED)
            {
                ::munmap(const_cast<char*>(data), file_sz);
            }
            if (fd >= 0)
            {
                ::close(fd);
                fd = -1;
            }
#endif
            data = nullptr;
            file_sz = 0;
            owns_mapping = false;
        }

        // ================================================================
        // String utilities
        // ================================================================

        static std::string_view trim(std::string_view sv)
        {
            while (!sv.empty() && (sv.front() <= ' ')) sv.remove_prefix(1);
            while (!sv.empty() && (sv.back() <= ' ')) sv.remove_suffix(1);
            return sv;
        }

        static std::string strip_end_kw(std::string_view sv)
        {
            auto p = sv.rfind("$end");
            if (p != std::string_view::npos) sv = trim(sv.substr(0, p));
            return std::string(sv);
        }

        // ================================================================
        // VCD type parsing
        // ================================================================

        static VarType parse_var_type(std::string_view s)
        {
            if (s == "wire") return VarType::Wire;
            if (s == "reg") return VarType::Reg;
            if (s == "integer") return VarType::Integer;
            if (s == "real") return VarType::Real;
            if (s == "parameter") return VarType::Parameter;
            if (s == "event") return VarType::Event;
            if (s == "supply0") return VarType::Supply0;
            if (s == "supply1") return VarType::Supply1;
            if (s == "tri") return VarType::Tri;
            if (s == "triand") return VarType::TriAnd;
            if (s == "trior") return VarType::TriOr;
            if (s == "trireg") return VarType::TriReg;
            if (s == "tri0") return VarType::Tri0;
            if (s == "tri1") return VarType::Tri1;
            if (s == "wand") return VarType::WAnd;
            if (s == "wor") return VarType::WOr;
            return VarType::Unknown;
        }

        static TimeUnit parse_time_unit(std::string_view s)
        {
            if (s == "s") return TimeUnit::S;
            if (s == "ms") return TimeUnit::MS;
            if (s == "us") return TimeUnit::US;
            if (s == "ns") return TimeUnit::NS;
            if (s == "ps") return TimeUnit::PS;
            if (s == "fs") return TimeUnit::FS;
            return TimeUnit::NS;
        }

        // ================================================================
        // Header parsing
        // ================================================================

        bool parse_header()
        {
            Scanner sc(data, data + file_sz);
            root = std::make_unique<ScopeNode>();
            root->name = "<root>";
            root->full_path = "";
            ScopeNode* cur_scope = root.get();

            while (!sc.eof())
            {
                sc.skip_ws();
                if (sc.eof()) break;
                if (*sc.pos() != '$')
                {
                    vc_offset = sc.offset(data);
                    break;
                }

                auto kw = sc.next_token();

                if (kw == "$date")
                {
                    auto c = sc.read_until_end();
                    date_str = strip_end_kw(trim(c));
                }
                else if (kw == "$version")
                {
                    auto c = sc.read_until_end();
                    version_str = strip_end_kw(trim(c));
                }
                else if (kw == "$timescale")
                {
                    std::string combined;
                    while (!sc.eof())
                    {
                        sc.skip_ws();
                        auto tok = sc.next_token();
                        if (tok == "$end") break;
                        combined += std::string(tok);
                    }
                    size_t i = 0;
                    while (i < combined.size() && combined[i] >= '0' &&
                           combined[i] <= '9')
                        ++i;
                    if (i > 0) ts.magnitude = std::stoi(combined.substr(0, i));
                    if (i < combined.size())
                        ts.unit = parse_time_unit(combined.substr(i));
                }
                else if (kw == "$scope")
                {
                    /*scope_type*/ sc.next_token();
                    auto scope_name = sc.next_token();
                    sc.skip_until("$end");

                    auto child = std::make_unique<ScopeNode>();
                    child->name = std::string(scope_name);
                    child->parent = cur_scope;
                    child->full_path =
                        cur_scope->full_path.empty()
                            ? child->name
                            : cur_scope->full_path + "." + child->name;
                    auto* raw = child.get();
                    cur_scope->children.push_back(std::move(child));
                    cur_scope = raw;
                }
                else if (kw == "$upscope")
                {
                    sc.skip_until("$end");
                    if (cur_scope->parent) cur_scope = cur_scope->parent;
                }
                else if (kw == "$var")
                {
                    parse_var(sc, cur_scope);
                }
                else if (kw == "$enddefinitions")
                {
                    sc.skip_until("$end");
                    // Check for $dumpvars
                    sc.skip_ws();
                    if (!sc.eof() && *sc.pos() == '$')
                    {
                        const char* save = sc.pos();
                        auto tok = sc.next_token();
                        if (tok == "$dumpvars")
                        {
                            parse_dumpvars(sc);
                        }
                        else if (tok == "$comment")
                        {
                            sc.read_until_end();
                        }
                        else
                        {
                            sc.set_pos(save);
                        }
                    }
                    vc_offset = sc.offset(data);
                    break;
                }
                else if (kw == "$comment")
                {
                    sc.read_until_end();
                }
                else
                {
                    sc.read_until_end();
                }
            }

            sig_transitions.resize(signal_defs.size());
            return true;
        }

        void parse_var(Scanner& sc, ScopeNode* cur_scope)
        {
            auto type_str = sc.next_token();
            auto width_str = sc.next_token();
            auto id_code = sc.next_token();
            auto name_tok = sc.next_token();

            std::string bit_range;
            while (!sc.eof())
            {
                sc.skip_ws();
                auto tok = sc.next_token();
                if (tok == "$end") break;
                bit_range += std::string(tok);
            }

            SignalDef sig;
            sig.type = parse_var_type(type_str);
            sig.width = 0;
            for (char c : width_str)
                if (c >= '0' && c <= '9')
                    sig.width = sig.width * 10 + (c - '0');
            if (sig.width == 0) sig.width = 1;

            sig.id_code = std::string(id_code);
            sig.name = std::string(name_tok);

            if (!bit_range.empty())
                parse_bit_range(bit_range, sig.msb, sig.lsb);

            sig.full_path = cur_scope->full_path.empty()
                                ? sig.name
                                : cur_scope->full_path + "." + sig.name;
            sig.index = static_cast<uint32_t>(signal_defs.size());

            cur_scope->signal_indices.push_back(sig.index);
            id_to_index[sig.id_code].push_back(sig.index);
            path_to_index[sig.full_path] = sig.index;
            signal_defs.push_back(std::move(sig));
        }

        static void parse_bit_range(const std::string& s, int& msb, int& lsb)
        {
            auto sb = s.find('['), sc2 = s.find(':'), se = s.find(']');
            if (sb == std::string::npos || se == std::string::npos) return;
            if (sc2 != std::string::npos && sc2 > sb && sc2 < se)
            {
                msb = std::stoi(s.substr(sb + 1, sc2 - sb - 1));
                lsb = std::stoi(s.substr(sc2 + 1, se - sc2 - 1));
            }
            else
            {
                msb = lsb = std::stoi(s.substr(sb + 1, se - sb - 1));
            }
        }

        // ================================================================
        // $dumpvars parsing
        // ================================================================

        void parse_dumpvars(Scanner& sc)
        {
            init_vals.resize(signal_defs.size(), "x");
            while (!sc.eof())
            {
                sc.skip_ws();
                if (sc.eof()) break;
                if (*sc.pos() == '$')
                {
                    auto tok = sc.next_token();
                    if (tok == "$end") break;
                    continue;
                }
                apply_value_change(sc, &init_vals);
            }
        }

        // ================================================================
        // Value-change line parsing (single line, no timestamp)
        // Returns pointer to vector of aliased signal indices, or nullptr
        // ================================================================

        const std::vector<uint32_t>* apply_value_change(
            Scanner& sc, std::vector<std::string>* vals)
        {
            char c = *sc.pos();

            if (c == 'b' || c == 'B' || c == 'r' || c == 'R')
            {
                auto val_tok = sc.next_token();  // e.g. "b0101"
                auto id_tok = sc.next_token();   // e.g. "!"
                auto it = id_to_index.find(std::string(id_tok));
                if (it != id_to_index.end())
                {
                    if (vals)
                    {
                        std::string v(val_tok);
                        for (uint32_t idx : it->second)
                            (*vals)[idx] = v;
                    }
                    return &it->second;
                }
            }
            else if (c == '0' || c == '1' || c == 'x' || c == 'X' || c == 'z' ||
                     c == 'Z')
            {
                auto tok = sc.next_token();  // e.g. "1!"
                if (tok.size() >= 2)
                {
                    std::string id(tok.substr(1));
                    auto it = id_to_index.find(id);
                    if (it != id_to_index.end())
                    {
                        if (vals)
                        {
                            std::string v(1, tok[0]);
                            for (uint32_t idx : it->second)
                                (*vals)[idx] = v;
                        }
                        return &it->second;
                    }
                }
            }
            else
            {
                sc.skip_line();
            }
            return nullptr;
        }

        // ================================================================
        // Pre-scan: build transition lists + chunk snapshots
        // ================================================================

        void prescan()
        {
            Scanner sc(data + vc_offset, data + file_sz);
            const char* base = data;

            size_t nsigs = signal_defs.size();
            std::vector<std::string> cur_vals;
            if (!init_vals.empty())
            {
                cur_vals = init_vals;
            }
            else
            {
                cur_vals.resize(nsigs, "x");
            }

            uint64_t cur_time = 0;
            bool first_ts = true;
            uint64_t next_boundary = 0;

            while (!sc.eof())
            {
                sc.skip_ws();
                if (sc.eof()) break;

                char c = *sc.pos();

                if (c == '#')
                {
                    // Timestamp line: #<number>
                    sc.advance(1);  // skip '#'
                    uint64_t tv = 0;
                    while (!sc.eof() && *sc.pos() >= '0' && *sc.pos() <= '9')
                    {
                        tv = tv * 10 + static_cast<uint64_t>(*sc.pos() - '0');
                        sc.advance(1);
                    }
                    sc.skip_line();

                    cur_time = tv;
                    if (first_ts)
                    {
                        t_begin = cur_time;
                        next_boundary = cur_time;
                        first_ts = false;
                    }
                    t_end = cur_time;

                    while (cur_time >= next_boundary)
                    {
                        create_snapshot(next_boundary, cur_vals);
                        next_boundary += chunk_size;
                    }
                }
                else if (c == '$')
                {
                    auto tok = sc.next_token();
                    if (tok == "$dumpvars" || tok == "$dumpoff" ||
                        tok == "$dumpon" || tok == "$dumpall")
                    {
                        while (!sc.eof())
                        {
                            sc.skip_ws();
                            if (sc.eof()) break;
                            if (*sc.pos() == '$')
                            {
                                auto et = sc.next_token();
                                if (et == "$end") break;
                                continue;
                            }
                            size_t off = sc.offset(base);
                            const char* ls = sc.pos();
                            auto* indices =
                                apply_value_change(sc, &cur_vals);
                            if (indices)
                            {
                                uint16_t len =
                                    static_cast<uint16_t>(sc.pos() - ls);
                                for (uint32_t idx : *indices)
                                    sig_transitions[idx].transitions.push_back(
                                        {cur_time, off, len});
                            }
                        }
                    }
                    else if (tok == "$comment")
                    {
                        sc.read_until_end();
                    }
                    else if (tok == "$end")
                    {
                        // stray $end
                    }
                    else
                    {
                        sc.read_until_end();
                    }
                }
                else
                {
                    // Value-change line
                    size_t off = sc.offset(base);
                    const char* ls = sc.pos();
                    auto* indices = apply_value_change(sc, &cur_vals);
                    if (indices)
                    {
                        uint16_t len = static_cast<uint16_t>(sc.pos() - ls);
                        for (uint32_t idx : *indices)
                            sig_transitions[idx].transitions.push_back(
                                {cur_time, off, len});
                    }
                }
            }

            // If first timestamp > 0, fix any transitions that were recorded
            // at time 0 (from $dump* blocks before the first #timestamp).
            // These should be attributed to t_begin, not time 0.
            if (t_begin > 0)
            {
                for (auto& st : sig_transitions)
                {
                    for (auto& tr : st.transitions)
                    {
                        if (tr.timestamp < t_begin)
                            tr.timestamp = t_begin;
                        else
                            break;  // transitions are in order
                    }
                }
            }

            // Final snapshot
            if (snapshots.empty() || snapshots.back().timestamp < t_end)
            {
                create_snapshot(t_end, cur_vals);
            }

            // Switch to random-access pattern for queries
#ifndef __EMSCRIPTEN__
            if (owns_mapping)
                ::madvise(const_cast<char*>(data), file_sz, MADV_RANDOM);
#endif
        }

        void create_snapshot(uint64_t snap_ts,
                             const std::vector<std::string>& cur_vals)
        {
            ChunkSnapshot snap;
            snap.timestamp = snap_ts;
            snap.values = cur_vals;

            snap.transition_cursors.resize(signal_defs.size());
            for (size_t i = 0; i < signal_defs.size(); ++i)
            {
                auto& trs = sig_transitions[i].transitions;
                auto it = std::lower_bound(trs.begin(), trs.end(), snap_ts,
                                           [](const Transition& t, uint64_t v)
                                           { return t.timestamp < v; });
                snap.transition_cursors[i] =
                    static_cast<uint32_t>(it - trs.begin());
            }
            snapshots.push_back(std::move(snap));
        }

        // ================================================================
        // Query: read value from mmap at a transition offset
        // ================================================================

        std::string read_value_at(const Transition& tr) const
        {
            const char* p = data + tr.file_offset;
            const char* end = p + tr.line_len;
            // skip whitespace
            while (p < end &&
                   (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r'))
                ++p;
            if (p >= end) return "x";

            char c = *p;
            if (c == 'b' || c == 'B' || c == 'r' || c == 'R')
            {
                const char* s = p;
                while (p < end && *p != ' ' && *p != '\t' && *p != '\n') ++p;
                return std::string(s, static_cast<size_t>(p - s));
            }
            if (c == '0' || c == '1' || c == 'x' || c == 'X' || c == 'z' ||
                c == 'Z')
            {
                return std::string(1, c);
            }
            return "x";
        }

        // ================================================================
        // Query: time range
        // ================================================================

        QueryResult do_query(uint64_t qb, uint64_t qe,
                             const std::vector<uint32_t>& indices) const
        {
            QueryResult res;
            res.t_begin = qb;
            res.t_end = qe;
            if (snapshots.empty() || indices.empty()) return res;

            // Find last snapshot with timestamp <= qb (binary search)
            size_t si = 0;
            {
                size_t lo = 0, hi = snapshots.size();
                while (lo < hi)
                {
                    size_t mid = lo + (hi - lo) / 2;
                    if (snapshots[mid].timestamp <= qb)
                        lo = mid + 1;
                    else
                        hi = mid;
                }
                si = (lo > 0) ? lo - 1 : 0;
            }
            const ChunkSnapshot& snap = snapshots[si];

            res.signals.reserve(indices.size());

            for (uint32_t idx : indices)
            {
                if (idx >= signal_defs.size()) continue;

                SignalQueryResult sqr;
                sqr.signal_index = idx;
                sqr.signal_name = signal_defs[idx].full_path;
                sqr.initial_value = snap.values[idx];

                auto& trs = sig_transitions[idx].transitions;
                uint32_t cur = snap.transition_cursors[idx];

                // Replay from snapshot to qb to get true initial value
                while (cur < trs.size() && trs[cur].timestamp < qb)
                {
                    sqr.initial_value = read_value_at(trs[cur]);
                    ++cur;
                }

                // Collect transitions within [qb, qe]
                while (cur < trs.size() && trs[cur].timestamp <= qe)
                {
                    sqr.transitions.emplace_back(trs[cur].timestamp,
                                                 read_value_at(trs[cur]));
                    ++cur;
                }

                res.signals.push_back(std::move(sqr));
            }
            return res;
        }
    };

    // ============================================================================
    // VcdParser public API forwarding
    // ============================================================================

    VcdParser::VcdParser() : impl_(std::make_unique<Impl>()) {}
    VcdParser::~VcdParser() { close(); }

    VcdParser::VcdParser(VcdParser&&) noexcept = default;
    VcdParser& VcdParser::operator=(VcdParser&&) noexcept = default;

    bool VcdParser::open(const std::string& filepath, uint64_t chunk_size)
    {
#ifdef __EMSCRIPTEN__
        (void)filepath;
        (void)chunk_size;
        return false;  // Use open_buffer() in WASM
#else
        close();
        impl_->chunk_size = chunk_size;
        if (!impl_->map_file(filepath)) return false;
        if (!impl_->parse_header())
        {
            impl_->release_data();
            return false;
        }
        impl_->prescan();
        return true;
#endif
    }

    bool VcdParser::open_buffer(const char* buf, size_t size,
                                uint64_t chunk_size)
    {
        close();
        impl_->chunk_size = chunk_size;
        if (!impl_->load_buffer(buf, size)) return false;
        if (!impl_->parse_header())
        {
            impl_->release_data();
            return false;
        }
        impl_->prescan();
        return true;
    }

    void VcdParser::close()
    {
        if (!impl_) return;
        impl_->release_data();
        impl_->signal_defs.clear();
        impl_->id_to_index.clear();
        impl_->path_to_index.clear();
        impl_->root.reset();
        impl_->sig_transitions.clear();
        impl_->snapshots.clear();
        impl_->init_vals.clear();
        impl_->date_str.clear();
        impl_->version_str.clear();
    }

    bool VcdParser::is_open() const { return impl_ && impl_->data != nullptr; }

    const Timescale& VcdParser::timescale() const { return impl_->ts; }
    uint64_t VcdParser::time_begin() const { return impl_->t_begin; }
    uint64_t VcdParser::time_end() const { return impl_->t_end; }
    size_t VcdParser::signal_count() const { return impl_->signal_defs.size(); }
    const std::string& VcdParser::date() const { return impl_->date_str; }
    const std::string& VcdParser::version() const { return impl_->version_str; }
    const std::vector<SignalDef>& VcdParser::signals() const
    {
        return impl_->signal_defs;
    }
    const ScopeNode* VcdParser::root_scope() const { return impl_->root.get(); }

    const SignalDef* VcdParser::find_signal(const std::string& full_path) const
    {
        auto it = impl_->path_to_index.find(full_path);
        return (it != impl_->path_to_index.end())
                   ? &impl_->signal_defs[it->second]
                   : nullptr;
    }

    uint32_t VcdParser::find_signal_by_id(const std::string& id_code) const
    {
        auto it = impl_->id_to_index.find(id_code);
        return (it != impl_->id_to_index.end() && !it->second.empty())
                   ? it->second.front()
                   : UINT32_MAX;
    }

    QueryResult VcdParser::query(
        uint64_t t_begin, uint64_t t_end,
        const std::vector<uint32_t>& signal_indices) const
    {
        return impl_->do_query(t_begin, t_end, signal_indices);
    }

    QueryResult VcdParser::query(
        uint64_t t_begin, uint64_t t_end,
        const std::vector<std::string>& signal_paths) const
    {
        std::vector<uint32_t> ids;
        ids.reserve(signal_paths.size());
        for (auto& p : signal_paths)
        {
            auto it = impl_->path_to_index.find(p);
            if (it != impl_->path_to_index.end()) ids.push_back(it->second);
        }
        return impl_->do_query(t_begin, t_end, ids);
    }

    size_t VcdParser::file_size() const { return impl_->file_sz; }
    size_t VcdParser::chunk_count() const { return impl_->snapshots.size(); }

    size_t VcdParser::total_transitions() const
    {
        size_t n = 0;
        for (auto& s : impl_->sig_transitions) n += s.transitions.size();
        return n;
    }

}  // namespace vcd
