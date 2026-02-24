#include "vcd_parser.h"

#include <algorithm>
#include <cassert>
#include <cstring>
#include <stdexcept>

namespace vcd
{

    // ============================================================================
    // Helper: Bit-packing for 1-bit states
    // ============================================================================

    inline uint8_t char_to_val2b(char c)
    {
        if (c == '0') return 0;
        if (c == '1') return 1;
        if (c == 'x' || c == 'X') return 2;
        if (c == 'z' || c == 'Z') return 3;
        return 2;
    }

    inline char val2b_to_char(uint8_t v)
    {
        static const char m[] = {'0', '1', 'x', 'z'};
        return m[v & 3];
    }

    inline void set_1bit_state(std::vector<uint64_t>& vec, uint32_t bit_index,
                               uint8_t val)
    {
        uint32_t word = bit_index / 32;
        uint32_t shift = (bit_index % 32) * 2;
        uint64_t mask = ~(3ULL << shift);
        vec[word] = (vec[word] & mask) | (static_cast<uint64_t>(val) << shift);
    }

    inline uint8_t get_1bit_state(const std::vector<uint64_t>& vec,
                                  uint32_t bit_index)
    {
        uint32_t word = bit_index / 32;
        uint32_t shift = (bit_index % 32) * 2;
        return static_cast<uint8_t>((vec[word] >> shift) & 3);
    }

    // ============================================================================
    // VcdParser::Impl
    // ============================================================================

    struct VcdParser::Impl
    {
        enum class Phase
        {
            Idle,
            Indexing,
            Querying
        };
        Phase phase = Phase::Idle;

        enum class ParseState
        {
            Header,
            Data
        };
        ParseState parse_state = ParseState::Header;

        // --- Line-buffering ---
        // Leftover bytes from the previous chunk that didn't form a complete
        // line. We track the file offset of the leftover start so that when
        // we concatenate leftover + new chunk, we can compute the correct
        // absolute file offset for any byte in the combined buffer.
        std::string leftover;
        uint64_t leftover_file_offset = 0;  // absolute file offset of
                                             // leftover[0]

        // --- Metadata ---
        std::string date_str;
        std::string version_str;
        Timescale ts;
        std::vector<SignalDef> signal_defs;
        std::unordered_map<std::string, std::vector<uint32_t>> id_to_index;
        std::unordered_map<std::string, uint32_t> path_to_index;
        std::unique_ptr<ScopeNode> root;
        ScopeNode* current_scope = nullptr;

        uint64_t t_begin = 0;
        uint64_t t_end = 0;
        bool first_ts = true;
        uint64_t current_time = 0;

        // --- State Trackers ---
        uint32_t num_1bit = 0;
        uint32_t num_multibit = 0;
        std::vector<uint64_t> current_state_1bit;
        std::vector<std::string> current_state_multibit;

        // --- Indexing Phase ---
        std::vector<Snapshot> snapshots;
        uint64_t last_snapshot_file_offset = 0;
        bool past_first_snapshot = false;
        static constexpr size_t SNAPSHOT_INTERVAL = 10 * 1024 * 1024;  // 10 MB
        bool header_done = false;

        // --- Query Phase ---
        uint64_t query_t_begin = 0;
        uint64_t query_t_end = 0;
        std::vector<uint32_t> query_signal_indices;
        bool query_initial_emitted = false;
        bool query_done = false;  // set when current_time > query_t_end

        std::vector<Transition1Bit> query_res_1bit;
        std::vector<TransitionMultiBit> query_res_multibit;
        std::string query_string_pool;
        QueryResultBinary binary_result = {};

        // O(1) lookup: is a given signal index in the query set?
        std::vector<bool> is_signal_queried;

        // ================================================================
        // Parsing Helpers
        // ================================================================

        void reset_state()
        {
            phase = Phase::Idle;
            parse_state = ParseState::Header;
            leftover.clear();
            leftover_file_offset = 0;
            date_str.clear();
            version_str.clear();
            signal_defs.clear();
            id_to_index.clear();
            path_to_index.clear();
            root.reset(new ScopeNode{"<root>", "", nullptr, {}, {}});
            current_scope = root.get();
            t_begin = t_end = current_time = 0;
            first_ts = true;
            num_1bit = num_multibit = 0;
            current_state_1bit.clear();
            current_state_multibit.clear();
            snapshots.clear();
            last_snapshot_file_offset = 0;
            past_first_snapshot = false;
            header_done = false;
        }

        static std::string_view trim(std::string_view sv)
        {
            while (!sv.empty() && (sv.front() <= ' ')) sv.remove_prefix(1);
            while (!sv.empty() && (sv.back() <= ' ')) sv.remove_suffix(1);
            return sv;
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

        void prepare_states()
        {
            uint32_t words = (num_1bit + 31) / 32;
            current_state_1bit.assign(
                words, 0xAAAAAAAAAAAAAAAAULL);  // Fill with 'x' (10)
            current_state_multibit.assign(num_multibit, "x");
            is_signal_queried.assign(signal_defs.size(), false);
        }

        // Apply a single value-change token.
        // If `emit` is true and the signal is in the query set, record a
        // transition.
        void apply_value_change(std::string_view token, bool emit)
        {
            if (token.empty()) return;

            char c = token[0];
            bool is_1bit = (c == '0' || c == '1' || c == 'x' || c == 'X' ||
                            c == 'z' || c == 'Z');

            std::string_view id_tok;
            std::string_view val_tok;

            if (is_1bit)
            {
                val_tok = token.substr(0, 1);
                id_tok = token.substr(1);
            }
            else if (c == 'b' || c == 'B' || c == 'r' || c == 'R')
            {
                size_t space = token.find(' ');
                if (space == std::string_view::npos) return;
                val_tok = token.substr(0, space);
                id_tok = trim(token.substr(space + 1));
            }
            else
            {
                return;
            }

            auto it = id_to_index.find(std::string(id_tok));
            if (it == id_to_index.end()) return;

            for (uint32_t idx : it->second)
            {
                auto& sig = signal_defs[idx];

                if (sig.width == 1 && is_1bit)
                {
                    uint8_t v = char_to_val2b(val_tok[0]);
                    set_1bit_state(current_state_1bit, sig.bit_index, v);

                    if (emit && is_signal_queried[idx])
                    {
                        query_res_1bit.push_back(
                            {current_time, idx, v, {0, 0, 0}});
                    }
                }
                else if (sig.width > 1)
                {
                    current_state_multibit[sig.str_index] =
                        std::string(val_tok);

                    if (emit && is_signal_queried[idx])
                    {
                        uint32_t offset =
                            static_cast<uint32_t>(query_string_pool.size());
                        query_string_pool.append(val_tok);
                        query_res_multibit.push_back(
                            {current_time, idx, offset,
                             static_cast<uint32_t>(val_tok.size()), 0});
                    }
                }
            }
        }

        // -----------------------------------------------------------------
        // process_buffer: parse a contiguous buffer of complete lines.
        //
        // `buf_file_offset` is the absolute file offset corresponding to
        // buf[0]. This is critical for computing correct snapshot offsets.
        //
        // Returns true normally, false if query is done (early stop).
        // -----------------------------------------------------------------
        bool process_buffer(std::string_view buf, uint64_t buf_file_offset)
        {
            size_t pos = 0;
            while (pos < buf.size())
            {
                size_t eol = buf.find('\n', pos);
                if (eol == std::string_view::npos) eol = buf.size();
                std::string_view line = trim(buf.substr(pos, eol - pos));

                // The absolute file offset of this line's start character
                uint64_t line_abs_offset = buf_file_offset + pos;

                pos = eol + 1;  // skip '\n'

                if (line.empty()) continue;

                if (parse_state == ParseState::Header)
                {
                    // After $enddefinitions, some VCD files (e.g. Verilator)
                    // omit $dumpvars and go straight to timestamps/values.
                    // Auto-transition to Data when we see a non-$ line after
                    // the header is done.
                    if (header_done && line[0] != '$')
                    {
                        parse_state = ParseState::Data;
                        if (!parse_data_line(line, line_abs_offset))
                            return false;
                    }
                    else
                    {
                        parse_header_line(line);
                    }
                }
                else
                {
                    if (!parse_data_line(line, line_abs_offset)) return false;
                }
            }
            return true;
        }

        // -----------------------------------------------------------------
        // Header parsing
        // -----------------------------------------------------------------
        void parse_header_line(std::string_view line)
        {
            if (line.rfind("$enddefinitions", 0) == 0)
            {
                header_done = true;
                prepare_states();
            }
            else if (line.rfind("$dumpvars", 0) == 0)
            {
                parse_state = ParseState::Data;
            }
            else if (line.rfind("$scope", 0) == 0)
            {
                size_t first_space = line.find(' ');
                size_t second_space =
                    (first_space != std::string_view::npos)
                        ? line.find(' ', first_space + 1)
                        : std::string_view::npos;
                if (second_space != std::string_view::npos)
                {
                    std::string_view name = line.substr(second_space + 1);
                    size_t end_kw = name.find("$end");
                    if (end_kw != std::string_view::npos)
                        name = trim(name.substr(0, end_kw));

                    auto child = std::make_unique<ScopeNode>();
                    child->name = std::string(name);
                    child->parent = current_scope;
                    child->full_path = current_scope->full_path.empty()
                                           ? child->name
                                           : current_scope->full_path + "." +
                                                 child->name;
                    current_scope->children.push_back(std::move(child));
                    current_scope = current_scope->children.back().get();
                }
            }
            else if (line.rfind("$upscope", 0) == 0)
            {
                if (current_scope->parent)
                    current_scope = current_scope->parent;
            }
            else if (line.rfind("$var", 0) == 0)
            {
                // $var wire 1 ! clk $end
                std::vector<std::string_view> toks;
                size_t s_pos = 0;
                while (s_pos < line.size())
                {
                    size_t s_next = line.find(' ', s_pos);
                    if (s_next == std::string_view::npos) s_next = line.size();
                    std::string_view t = line.substr(s_pos, s_next - s_pos);
                    if (!t.empty()) toks.push_back(t);
                    s_pos = s_next + 1;
                }
                if (toks.size() >= 5)
                {
                    SignalDef sig;
                    sig.width = std::stoi(std::string(toks[2]));
                    sig.id_code = std::string(toks[3]);
                    sig.name = std::string(toks[4]);
                    sig.full_path = current_scope->full_path.empty()
                                        ? sig.name
                                        : current_scope->full_path + "." +
                                              sig.name;
                    sig.index = static_cast<uint32_t>(signal_defs.size());

                    if (sig.width == 1)
                    {
                        sig.bit_index = num_1bit++;
                    }
                    else
                    {
                        sig.str_index = num_multibit++;
                    }

                    current_scope->signal_indices.push_back(sig.index);
                    id_to_index[sig.id_code].push_back(sig.index);
                    path_to_index[sig.full_path] = sig.index;
                    signal_defs.push_back(sig);
                }
            }
            else if (line.rfind("$timescale", 0) == 0)
            {
                std::string_view ts_val = line.substr(10);
                size_t end_kw = ts_val.find("$end");
                if (end_kw != std::string_view::npos)
                    ts_val = ts_val.substr(0, end_kw);
                ts_val = trim(ts_val);
                size_t dig = 0;
                while (dig < ts_val.size() && ts_val[dig] >= '0' &&
                       ts_val[dig] <= '9')
                    dig++;
                if (dig > 0)
                    ts.magnitude =
                        std::stoi(std::string(ts_val.substr(0, dig)));
                if (dig < ts_val.size())
                    ts.unit = parse_time_unit(trim(ts_val.substr(dig)));
            }
        }

        // -----------------------------------------------------------------
        // Data-section parsing (one line at a time).
        // Returns false when the query window has been exceeded (early stop).
        // -----------------------------------------------------------------
        bool parse_data_line(std::string_view line, uint64_t line_abs_offset)
        {
            if (line[0] == '#')
            {
                uint64_t new_time =
                    std::stoull(std::string(line.substr(1)));

                // --- Indexing: snapshot creation ---
                if (phase == Phase::Indexing)
                {
                    // Check if we should create a snapshot.
                    // Condition: we have accumulated >= SNAPSHOT_INTERVAL
                    // bytes since the last snapshot (or the beginning of file).
                    if (!past_first_snapshot)
                    {
                        // Take the very first snapshot at the first timestamp
                        // encountered in the data section.
                        Snapshot snap;
                        snap.time = current_time;
                        snap.file_offset = line_abs_offset;
                        snap.packed_1bit_states = current_state_1bit;
                        snap.multibit_states = current_state_multibit;
                        snapshots.push_back(std::move(snap));
                        last_snapshot_file_offset = line_abs_offset;
                        past_first_snapshot = true;
                    }
                    else if (line_abs_offset >=
                             last_snapshot_file_offset + SNAPSHOT_INTERVAL)
                    {
                        // Snapshot BEFORE updating to new_time: the
                        // snapshot records the state at current_time
                        // (all value changes up to but not past it).
                        Snapshot snap;
                        snap.time = current_time;
                        snap.file_offset = line_abs_offset;
                        snap.packed_1bit_states = current_state_1bit;
                        snap.multibit_states = current_state_multibit;
                        snapshots.push_back(std::move(snap));
                        last_snapshot_file_offset = line_abs_offset;
                    }
                }

                // Now update current_time
                current_time = new_time;
                if (first_ts)
                {
                    t_begin = current_time;
                    first_ts = false;
                }
                t_end = current_time;

                // --- Query: check early stop ---
                if (phase == Phase::Querying)
                {
                    if (!query_initial_emitted &&
                        current_time >= query_t_begin)
                    {
                        emit_query_initial_state();
                        query_initial_emitted = true;
                    }
                    if (current_time > query_t_end)
                    {
                        query_done = true;
                        return false;  // early stop
                    }
                }
            }
            else if (line[0] == '$')
            {
                // Handle $dumpvars/$dumpoff/$dumpon/$dumpall etc.
                if (line.rfind("$dump", 0) == 0)
                {
                    size_t v_pos = line.find(' ');
                    if (v_pos != std::string_view::npos)
                    {
                        std::string_view content = line.substr(v_pos + 1);
                        size_t e_pos = content.rfind("$end");
                        if (e_pos != std::string_view::npos)
                            content = content.substr(0, e_pos);
                        content = trim(content);
                        if (!content.empty())
                        {
                            apply_value_change(content, false);
                        }
                    }
                }
            }
            else
            {
                bool emit =
                    (phase == Phase::Querying && query_initial_emitted &&
                     current_time <= query_t_end);

                // Parse value changes (possibly multiple on one line)
                size_t s_pos = 0;
                while (s_pos < line.size())
                {
                    std::string_view rem = line.substr(s_pos);
                    if (rem[0] == 'b' || rem[0] == 'B' || rem[0] == 'r' ||
                        rem[0] == 'R')
                    {
                        size_t sp1 = rem.find(' ');
                        if (sp1 == std::string_view::npos) break;
                        size_t sp2 = rem.find(' ', sp1 + 1);
                        std::string_view tok = rem.substr(0, sp2);
                        apply_value_change(tok, emit);
                        s_pos += tok.size() + 1;
                    }
                    else
                    {
                        size_t sp = rem.find(' ');
                        std::string_view tok = rem.substr(0, sp);
                        apply_value_change(tok, emit);
                        if (sp == std::string_view::npos) break;
                        s_pos += sp + 1;
                    }
                }
            }
            return true;
        }

        void emit_query_initial_state()
        {
            for (uint32_t idx : query_signal_indices)
            {
                if (idx >= signal_defs.size()) continue;
                auto& sig = signal_defs[idx];
                if (sig.width == 1)
                {
                    uint8_t v =
                        get_1bit_state(current_state_1bit, sig.bit_index);
                    query_res_1bit.push_back(
                        {query_t_begin, idx, v, {0, 0, 0}});
                }
                else
                {
                    const std::string& sv =
                        current_state_multibit[sig.str_index];
                    uint32_t offset =
                        static_cast<uint32_t>(query_string_pool.size());
                    query_string_pool.append(sv);
                    query_res_multibit.push_back(
                        {query_t_begin, idx, offset,
                         static_cast<uint32_t>(sv.size()), 0});
                }
            }
        }

        // -----------------------------------------------------------------
        // push_chunk: shared logic for both indexing and query phases.
        //
        // Maintains a leftover buffer for incomplete lines.
        // `chunk_file_offset` is the absolute offset in the original file
        // where `data` begins.
        //
        // Returns true if more data is needed, false if done (query early
        // stop).
        // -----------------------------------------------------------------
        bool push_chunk(const uint8_t* data, size_t size,
                        uint64_t chunk_file_offset)
        {
            // Concatenate leftover + new data
            size_t leftover_len = leftover.size();
            leftover.append(reinterpret_cast<const char*>(data), size);

            // The absolute file offset of leftover[0] is
            // leftover_file_offset (set when leftover was established).
            // After appending, leftover[leftover_len] corresponds to
            // chunk_file_offset.
            // So leftover[0] corresponds to:
            //   chunk_file_offset - leftover_len
            // BUT leftover_file_offset was already set correctly when the
            // leftover was saved. Verify consistency:
            // leftover_file_offset should equal chunk_file_offset - leftover_len
            // (This holds because we set it correctly below.)

            uint64_t buf_file_offset = leftover_file_offset;

            // Find the last newline - only process complete lines
            size_t last_nl = leftover.find_last_of('\n');
            if (last_nl == std::string::npos)
            {
                // No complete line yet; keep everything in leftover.
                // leftover_file_offset stays unchanged.
                return true;
            }

            // Process everything up to and including the last newline
            std::string_view process_view(leftover.data(), last_nl + 1);
            bool cont = process_buffer(process_view, buf_file_offset);

            // Save the remainder as the new leftover
            size_t remaining = leftover.size() - (last_nl + 1);
            if (remaining > 0)
            {
                std::string new_leftover(leftover.data() + last_nl + 1,
                                         remaining);
                leftover_file_offset = buf_file_offset + last_nl + 1;
                leftover = std::move(new_leftover);
            }
            else
            {
                leftover.clear();
                leftover_file_offset = buf_file_offset + last_nl + 1;
            }

            return cont;
        }
    };

    // ============================================================================
    // VcdParser public API
    // ============================================================================

    VcdParser::VcdParser() : impl_(std::make_unique<Impl>())
    {
        impl_->reset_state();
    }
    VcdParser::~VcdParser() = default;

    VcdParser::VcdParser(VcdParser&&) noexcept = default;
    VcdParser& VcdParser::operator=(VcdParser&&) noexcept = default;

    bool VcdParser::is_open() const { return impl_->header_done; }

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

    // ========================================================================
    // Indexing Phase
    // ========================================================================

    void VcdParser::begin_indexing()
    {
        impl_->reset_state();
        impl_->phase = Impl::Phase::Indexing;
    }

    bool VcdParser::push_chunk_for_index(const uint8_t* data, size_t size,
                                         uint64_t file_offset)
    {
        return impl_->push_chunk(data, size, file_offset);
    }

    void VcdParser::finish_indexing()
    {
        // Process any remaining leftover
        if (!impl_->leftover.empty())
        {
            impl_->process_buffer(impl_->leftover,
                                  impl_->leftover_file_offset);
            impl_->leftover.clear();
        }

        // Create a final snapshot if the last one is stale
        if (impl_->snapshots.empty() ||
            impl_->snapshots.back().time < impl_->current_time)
        {
            Snapshot snap;
            snap.time = impl_->current_time;
            // Point to "end of file" - this snapshot won't be seeked to for
            // re-reading, it's just for completeness.
            snap.file_offset =
                impl_->leftover_file_offset;  // approximate EOF
            snap.packed_1bit_states = impl_->current_state_1bit;
            snap.multibit_states = impl_->current_state_multibit;
            impl_->snapshots.push_back(std::move(snap));
        }

        impl_->phase = Impl::Phase::Idle;
    }

    // ========================================================================
    // Query Phase
    // ========================================================================

    QueryPlan VcdParser::get_query_plan(uint64_t start_time) const
    {
        QueryPlan plan = {0, 0, 0};
        if (impl_->snapshots.empty()) return plan;

        // Binary search: find the last snapshot with time <= start_time
        size_t lo = 0, hi = impl_->snapshots.size();
        while (lo < hi)
        {
            size_t mid = lo + (hi - lo) / 2;
            if (impl_->snapshots[mid].time <= start_time)
                lo = mid + 1;
            else
                hi = mid;
        }
        size_t si = (lo > 0) ? lo - 1 : 0;

        const Snapshot& snap = impl_->snapshots[si];
        plan.file_offset = snap.file_offset;
        plan.snapshot_time = snap.time;
        plan.snapshot_index = si;
        return plan;
    }

    void VcdParser::begin_query(uint64_t start_time, uint64_t end_time,
                                const std::vector<uint32_t>& signal_indices,
                                size_t snapshot_index)
    {
        impl_->phase = Impl::Phase::Querying;
        impl_->query_t_begin = start_time;
        impl_->query_t_end = end_time;
        impl_->query_signal_indices = signal_indices;
        impl_->query_initial_emitted = false;
        impl_->query_done = false;
        impl_->query_res_1bit.clear();
        impl_->query_res_multibit.clear();
        impl_->query_string_pool.clear();
        impl_->leftover.clear();
        impl_->leftover_file_offset = 0;

        // Restore state from the specified snapshot
        if (snapshot_index < impl_->snapshots.size())
        {
            const Snapshot& snap = impl_->snapshots[snapshot_index];
            impl_->current_state_1bit = snap.packed_1bit_states;
            impl_->current_state_multibit = snap.multibit_states;
            impl_->current_time = snap.time;
            impl_->leftover_file_offset = snap.file_offset;
        }
        else
        {
            impl_->prepare_states();
            impl_->current_time = 0;
        }

        // Switch to data-section parsing (we're seeking past the header)
        impl_->parse_state = Impl::ParseState::Data;

        // Mark actively queried signals for O(1) lookup
        std::fill(impl_->is_signal_queried.begin(),
                  impl_->is_signal_queried.end(), false);
        for (uint32_t idx : signal_indices)
        {
            if (idx < impl_->is_signal_queried.size())
            {
                impl_->is_signal_queried[idx] = true;
            }
        }
    }

    bool VcdParser::push_chunk_for_query(const uint8_t* data, size_t size)
    {
        if (impl_->phase != Impl::Phase::Querying) return false;
        if (impl_->query_done) return false;

        // For query chunks, the caller already seeked to the right offset.
        // We don't need precise file offsets during queries (they are only
        // used for snapshot creation during indexing). We pass 0 as the
        // file_offset since we don't create snapshots during queries.
        return impl_->push_chunk(data, size, 0);
    }

    QueryResultBinary VcdParser::finish_query_binary()
    {
        // Process any remaining leftover if the query hasn't ended early
        if (!impl_->leftover.empty() && !impl_->query_done)
        {
            impl_->process_buffer(impl_->leftover,
                                  impl_->leftover_file_offset);
        }

        // Ensure initial state is emitted even if data never reached
        // query_t_begin
        if (!impl_->query_initial_emitted)
        {
            impl_->emit_query_initial_state();
            impl_->query_initial_emitted = true;
        }

        impl_->binary_result.transitions_1bit =
            impl_->query_res_1bit.empty() ? nullptr
                                          : impl_->query_res_1bit.data();
        impl_->binary_result.count_1bit = impl_->query_res_1bit.size();

        impl_->binary_result.transitions_multibit =
            impl_->query_res_multibit.empty()
                ? nullptr
                : impl_->query_res_multibit.data();
        impl_->binary_result.count_multibit =
            impl_->query_res_multibit.size();

        impl_->binary_result.string_pool = impl_->query_string_pool.empty()
                                               ? nullptr
                                               : impl_->query_string_pool.data();
        impl_->binary_result.string_pool_size =
            impl_->query_string_pool.size();

        impl_->phase = Impl::Phase::Idle;
        return impl_->binary_result;
    }

    // --- Statistics ---
    size_t VcdParser::snapshot_count() const { return impl_->snapshots.size(); }
    size_t VcdParser::index_memory_usage() const
    {
        size_t b = 0;
        for (auto& s : impl_->snapshots)
        {
            b += s.packed_1bit_states.size() * sizeof(uint64_t);
            for (auto& st : s.multibit_states) b += st.size();
        }
        return b;
    }

}  // namespace vcd
