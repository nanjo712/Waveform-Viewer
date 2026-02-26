#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdlib>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

#include "vcd_parser.h"

using namespace emscripten;
using json = nlohmann::json;

// ============================================================================
// WASM wrapper: operates on 0-copy binary chunks and high-precision BigInts
// ============================================================================

class VcdParserWasm
{
   public:
    VcdParserWasm() = default;
    ~VcdParserWasm() { close(); }

    void close() { parser_.close_file(); }

    bool isOpen() const { return parser_.is_open(); }

    // --- File I/O ---
    bool open_file(const std::string& filepath)
    {
        return parser_.open_file(filepath);
    }
    void close_file() { parser_.close_file(); }

    // --- Indexing Phase ---

    // --- Chunk Memory Allocation ---

    // Removed allocate_chunk_buffer

    // --- Indexing Phase ---

    void begin_indexing() { parser_.begin_indexing(); }

    size_t index_step(size_t chunk_size)
    {
        return parser_.index_step(chunk_size);
    }

    void finish_indexing() { parser_.finish_indexing(); }

    // --- Query Phase ---

    emscripten::val get_query_plan(uint64_t start_time) const
    {
        vcd::QueryPlan plan = parser_.get_query_plan(start_time);
        auto obj = emscripten::val::object();
        obj.set("file_offset", val(plan.file_offset));
        obj.set("snapshot_time", val(plan.snapshot_time));
        obj.set("snapshot_index",
                val(static_cast<uint32_t>(plan.snapshot_index)));
        return obj;
    }

    void begin_query(uint64_t start_time, uint64_t end_time,
                     const std::string& indicesJSON, uint32_t snapshot_index,
                     float pixel_time_step)
    {
        auto parsed = json::parse(indicesJSON);
        std::vector<uint32_t> indices = parsed.get<std::vector<uint32_t>>();
        parser_.begin_query(start_time, end_time, indices,
                            static_cast<size_t>(snapshot_index),
                            pixel_time_step);
    }

    bool query_step(size_t chunk_size)
    {
        return parser_.query_step(chunk_size);
    }

    void cancel_query() { parser_.cancel_query(); }

    // Return mapping addresses instead of JSON serialization
    emscripten::val flush_query_binary()
    {
        auto res = parser_.flush_query_binary();
        auto obj = emscripten::val::object();

        obj.set("ptr1Bit",
                val(reinterpret_cast<uintptr_t>(res.transitions_1bit)));
        obj.set("count1Bit", val(res.count_1bit));

        obj.set("ptrMulti",
                val(reinterpret_cast<uintptr_t>(res.transitions_multibit)));
        obj.set("countMulti", val(res.count_multibit));

        obj.set("ptrStringPool",
                val(reinterpret_cast<uintptr_t>(res.string_pool)));
        obj.set("countStringPool", val(res.string_pool_size));

        return obj;
    }

    // --- Metadata ---

    std::string getDate() const { return parser_.date(); }
    std::string getVersion() const { return parser_.version(); }

    uint32_t getTimescaleMagnitude() const
    {
        return static_cast<uint32_t>(parser_.timescale().magnitude);
    }

    std::string getTimescaleUnit() const
    {
        switch (parser_.timescale().unit)
        {
            case vcd::TimeUnit::S:
                return "s";
            case vcd::TimeUnit::MS:
                return "ms";
            case vcd::TimeUnit::US:
                return "us";
            case vcd::TimeUnit::NS:
                return "ns";
            case vcd::TimeUnit::PS:
                return "ps";
            case vcd::TimeUnit::FS:
                return "fs";
        }
        return "ns";
    }

    uint64_t getTimeBegin() const { return parser_.time_begin(); }
    uint64_t getTimeEnd() const { return parser_.time_end(); }
    uint32_t getSignalCount() const
    {
        return static_cast<uint32_t>(parser_.signal_count());
    }
    uint32_t getSnapshotCount() const
    {
        return static_cast<uint32_t>(parser_.snapshot_count());
    }
    uint32_t getIndexMemoryUsage() const
    {
        return static_cast<uint32_t>(parser_.index_memory_usage());
    }

    // --- Signal list as JSON ---
    std::string getSignalsJSON() const
    {
        auto& sigs = parser_.signals();
        json arr = json::array();
        for (auto& s : sigs)
        {
            json obj = {
                {"name", s.name},      {"fullPath", s.full_path},
                {"idCode", s.id_code}, {"width", s.width},
                {"index", s.index},    {"type", varTypeStr(s.type)},
            };
            if (s.msb >= 0)
            {
                obj["msb"] = s.msb;
                obj["lsb"] = s.lsb;
            }
            arr.push_back(std::move(obj));
        }
        return arr.dump();
    }

    // --- Hierarchy as JSON ---
    std::string getHierarchyJSON() const
    {
        auto* root = parser_.root_scope();
        if (!root) return "{}";
        return serializeScope(root).dump();
    }

    int findSignal(const std::string& fullPath) const
    {
        auto* sig = parser_.find_signal(fullPath);
        if (!sig) return -1;
        return static_cast<int>(sig->index);
    }

   private:
    vcd::VcdParser parser_;

    // --- Helpers ---
    static const char* varTypeStr(vcd::VarType t)
    {
        switch (t)
        {
            case vcd::VarType::Wire:
                return "wire";
            case vcd::VarType::Reg:
                return "reg";
            case vcd::VarType::Integer:
                return "integer";
            case vcd::VarType::Real:
                return "real";
            case vcd::VarType::Parameter:
                return "parameter";
            case vcd::VarType::Event:
                return "event";
            case vcd::VarType::Supply0:
                return "supply0";
            case vcd::VarType::Supply1:
                return "supply1";
            case vcd::VarType::Tri:
                return "tri";
            case vcd::VarType::TriAnd:
                return "triand";
            case vcd::VarType::TriOr:
                return "trior";
            case vcd::VarType::TriReg:
                return "trireg";
            case vcd::VarType::Tri0:
                return "tri0";
            case vcd::VarType::Tri1:
                return "tri1";
            case vcd::VarType::WAnd:
                return "wand";
            case vcd::VarType::WOr:
                return "wor";
            default:
                return "unknown";
        }
    }

    static json serializeScope(const vcd::ScopeNode* node)
    {
        json obj = {
            {"name", node->name},
            {"fullPath", node->full_path},
        };
        if (!node->signal_indices.empty())
        {
            obj["signals"] = node->signal_indices;
        }
        if (!node->children.empty())
        {
            json children = json::array();
            for (auto& child : node->children)
            {
                children.push_back(serializeScope(child.get()));
            }
            obj["children"] = std::move(children);
        }
        return obj;
    }
};

// ============================================================================
// FstParserWasm: Drop-in replacement for VcdParserWasm using libfst
// ============================================================================
#include <unordered_map>

#include "fstapi.h"

class FstParserWasm
{
   public:
    FstParserWasm() = default;
    ~FstParserWasm() { close(); }

    void close() { close_file(); }

    bool isOpen() const { return ctx_ != nullptr; }

    bool open_file(const std::string& filepath)
    {
        close();
        ctx_ = fstReaderOpen(filepath.c_str());
        return ctx_ != nullptr;
    }

    void close_file()
    {
        if (ctx_)
        {
            fstReaderClose(ctx_);
            ctx_ = nullptr;
        }
        signals_.clear();
        root_scope_ = nullptr;
        sig_map_.clear();
        handle_to_sig_.clear();
    }

    void begin_indexing() {}

    size_t index_step(size_t chunk_size)
    {
        return 0;  // FST doesn't need chunked indexing the same way
    }

    void finish_indexing()
    {
        if (!ctx_) return;

        root_scope_ = std::make_unique<vcd::ScopeNode>();
        root_scope_->name = "__root__";
        root_scope_->full_path = "";

        std::vector<vcd::ScopeNode*> stack;
        stack.push_back(root_scope_.get());

        struct fstHier* h;
        while ((h = fstReaderIterateHier(ctx_)))
        {
            switch (h->htyp)
            {
                case FST_HT_SCOPE:
                {
                    auto scope = std::make_unique<vcd::ScopeNode>();
                    scope->name =
                        std::string(h->u.scope.name, h->u.scope.name_length);
                    scope->parent = stack.back();
                    scope->full_path =
                        scope->parent->full_path.empty()
                            ? scope->name
                            : scope->parent->full_path + "." + scope->name;

                    vcd::ScopeNode* raw_ptr = scope.get();
                    stack.back()->children.push_back(std::move(scope));
                    stack.push_back(raw_ptr);
                    break;
                }
                case FST_HT_UPSCOPE:
                {
                    if (stack.size() > 1)
                    {
                        stack.pop_back();
                    }
                    break;
                }
                case FST_HT_VAR:
                {
                    if (h->u.var.is_alias)
                        break;  // Skip aliases, they resolve to the same
                                // variable

                    vcd::SignalDef sig;
                    sig.name = std::string(h->u.var.name, h->u.var.name_length);
                    sig.full_path = stack.back()->full_path + "." + sig.name;
                    sig.width = h->u.var.length;
                    sig.id_code = std::to_string(h->u.var.handle);
                    sig.index = static_cast<uint32_t>(signals_.size());

                    switch (h->u.var.typ)
                    {
                        case FST_VT_VCD_WIRE:
                            sig.type = vcd::VarType::Wire;
                            break;
                        case FST_VT_VCD_REG:
                            sig.type = vcd::VarType::Reg;
                            break;
                        case FST_VT_VCD_INTEGER:
                            sig.type = vcd::VarType::Integer;
                            break;
                        case FST_VT_VCD_PARAMETER:
                            sig.type = vcd::VarType::Parameter;
                            break;
                        case FST_VT_VCD_REAL:
                            sig.type = vcd::VarType::Real;
                            break;
                        default:
                            sig.type = vcd::VarType::Unknown;
                            break;
                    }

                    handle_to_sig_[h->u.var.handle] = sig.index;
                    signals_.push_back(std::move(sig));
                    stack.back()->signal_indices.push_back(sig.index);
                    sig_map_[sig.full_path] = sig.index;
                    break;
                }
            }
        }
    }

    // --- Stats / Metadata ---

    std::string getDate() const
    {
        return ctx_ ? fstReaderGetDateString(ctx_) : "";
    }
    std::string getVersion() const
    {
        return ctx_ ? fstReaderGetVersionString(ctx_) : "";
    }

    uint32_t getTimescaleMagnitude() const
    {
        if (!ctx_) return 1;
        int ts = fstReaderGetTimescale(ctx_);
        if (ts == -3) return 1;   // ms
        if (ts == -6) return 1;   // us
        if (ts == -9) return 1;   // ns
        if (ts == -12) return 1;  // ps
        if (ts == -15) return 1;  // fs

        if (ts == -2) return 10;
        if (ts == -5) return 10;
        if (ts == -8) return 10;
        if (ts == -11) return 10;
        if (ts == -14) return 10;

        if (ts == -1) return 100;
        if (ts == -4) return 100;
        if (ts == -7) return 100;
        if (ts == -10) return 100;
        if (ts == -13) return 100;

        return 1;
    }

    std::string getTimescaleUnit() const
    {
        if (!ctx_) return "ns";
        int ts = fstReaderGetTimescale(ctx_);
        if (ts >= -3) return "ms";
        if (ts >= -6) return "us";
        if (ts >= -9) return "ns";
        if (ts >= -12) return "ps";
        return "fs";
    }

    uint64_t getTimeBegin() const
    {
        return ctx_ ? fstReaderGetStartTime(ctx_) : 0;
    }
    uint64_t getTimeEnd() const { return ctx_ ? fstReaderGetEndTime(ctx_) : 0; }
    uint32_t getSignalCount() const
    {
        return static_cast<uint32_t>(signals_.size());
    }
    uint32_t getSnapshotCount() const { return 0; }
    uint32_t getIndexMemoryUsage() const { return 0; }

    // --- JSON Serialization ---

    std::string getSignalsJSON() const
    {
        json arr = json::array();
        for (auto& s : signals_)
        {
            json obj = {
                {"name", s.name},      {"fullPath", s.full_path},
                {"idCode", s.id_code}, {"width", s.width},
                {"index", s.index},    {"type", varTypeStr(s.type)},
            };
            if (s.msb >= 0)
            {
                obj["msb"] = s.msb;
                obj["lsb"] = s.lsb;
            }
            arr.push_back(std::move(obj));
        }
        return arr.dump();
    }

    std::string getHierarchyJSON() const
    {
        if (!root_scope_) return "{}";
        return serializeScope(root_scope_.get()).dump();
    }

    int findSignal(const std::string& fullPath) const
    {
        auto it = sig_map_.find(fullPath);
        if (it != sig_map_.end()) return static_cast<int>(it->second);
        return -1;
    }

    // --- Querying ---

    emscripten::val get_query_plan(uint64_t start_time) const
    {
        auto obj = emscripten::val::object();
        obj.set("file_offset", val(0));
        obj.set("snapshot_time", val(start_time));
        obj.set("snapshot_index", val((uint32_t)0));
        return obj;
    }

    void begin_query(uint64_t start_time, uint64_t end_time,
                     const std::string& indicesJSON, uint32_t snapshot_index,
                     float pixel_time_step)
    {
        if (!ctx_) return;

        pixel_time_step_ = pixel_time_step;
        query_t_begin_ = start_time;
        query_t_end_ = end_time;

        fstReaderSetLimitTimeRange(ctx_, start_time, end_time);
        fstReaderClrFacProcessMaskAll(ctx_);

        last_emitted_time_.assign(signals_.size(), 0xFFFFFFFFFFFFFFFFULL);

        res_1bit_.clear();
        res_multi_.clear();
        string_pool_.clear();
        query_done_ = false;

        auto parsed = json::parse(indicesJSON);
        std::vector<uint32_t> indices = parsed.get<std::vector<uint32_t>>();

        // Initial state restoration: get values at start_time for all queried
        // signals. Use a reuseable buffer for signal values.
        std::vector<char> val_buf(65536);

        for (uint32_t idx : indices)
        {
            if (idx < signals_.size())
            {
                fstHandle handle = std::stoull(signals_[idx].id_code);
                fstReaderSetFacProcessMask(ctx_, handle);

                // Fetch current value at start_time
                uint32_t width = signals_[idx].width;
                if (width + 1 > val_buf.size()) val_buf.resize(width + 1);

                char* v = fstReaderGetValueFromHandleAtTime(
                    ctx_, start_time, handle, val_buf.data());
                if (v)
                {
                    handle_value(start_time, handle,
                                 reinterpret_cast<const unsigned char*>(v),
                                 width);
                }
            }
        }
    }

    bool query_step(size_t chunk_size)
    {
        if (!ctx_ || query_done_) return false;

        fstReaderIterBlocks2(ctx_, fst_callback, fst_callback_varlen, this,
                             nullptr);

        query_done_ = true;
        return false;
    }

    void cancel_query() { query_done_ = true; }

    emscripten::val flush_query_binary()
    {
        auto obj = emscripten::val::object();

        obj.set("ptr1Bit", val(reinterpret_cast<uintptr_t>(res_1bit_.data())));
        obj.set("count1Bit", val(res_1bit_.size()));

        obj.set("ptrMulti",
                val(reinterpret_cast<uintptr_t>(res_multi_.data())));
        obj.set("countMulti", val(res_multi_.size()));

        obj.set("ptrStringPool",
                val(reinterpret_cast<uintptr_t>(string_pool_.data())));
        obj.set("countStringPool", val(string_pool_.size()));

        return obj;
    }

   private:
    fstReaderContext* ctx_ = nullptr;
    std::vector<vcd::SignalDef> signals_;
    std::unique_ptr<vcd::ScopeNode> root_scope_;
    std::unordered_map<std::string, uint32_t> sig_map_;
    std::unordered_map<fstHandle, uint32_t> handle_to_sig_;

    std::vector<vcd::Transition1Bit> res_1bit_;
    std::vector<vcd::TransitionMultiBit> res_multi_;
    std::vector<char> string_pool_;

    float pixel_time_step_ = -1.0f;
    std::vector<uint64_t> last_emitted_time_;
    uint64_t query_t_begin_ = 0;
    uint64_t query_t_end_ = 0;
    size_t total_rx_count_ = 0;
    size_t in_range_count_ = 0;
    size_t not_in_range_count_ = 0;

    bool query_done_{false};

    static void fst_callback(void* user_data, uint64_t time, fstHandle facidx,
                             const unsigned char* value)
    {
        auto* self = static_cast<FstParserWasm*>(user_data);
        self->handle_value(time, facidx, value, 0);
    }

    static void fst_callback_varlen(void* user_data, uint64_t time,
                                    fstHandle facidx,
                                    const unsigned char* value, uint32_t len)
    {
        auto* self = static_cast<FstParserWasm*>(user_data);
        self->handle_value(time, facidx, value, len);
    }

    void handle_value(uint64_t time, fstHandle facidx,
                      const unsigned char* value, uint32_t len)
    {
        if (time < query_t_begin_ || time > query_t_end_) return;

        auto it = handle_to_sig_.find(facidx);
        if (it == handle_to_sig_.end()) return;
        uint32_t sig_idx = it->second;

        // LOD Downsampling
        if (pixel_time_step_ > 0.0f &&
            last_emitted_time_[sig_idx] != 0xFFFFFFFFFFFFFFFFULL)
        {
            if ((time - last_emitted_time_[sig_idx]) <
                static_cast<uint64_t>(pixel_time_step_))
            {
                return;
            }
        }

        in_range_count_++;
        last_emitted_time_[sig_idx] = time;

        const vcd::SignalDef& sig = signals_[sig_idx];

        if (len == 0)
            len = static_cast<uint32_t>(
                std::strlen(reinterpret_cast<const char*>(value)));

        if (sig.width == 1)
        {
            vcd::Transition1Bit t;
            t.timestamp = time;
            t.signal_index = sig_idx;
            uint8_t v = value[0];
            if (v == '0')
                t.value = 0;
            else if (v == '1')
                t.value = 1;
            else if (v == 'x' || v == 'X')
                t.value = 2;
            else if (v == 'z' || v == 'Z')
                t.value = 3;
            else
                t.value = 0;

            res_1bit_.push_back(t);
        }
        else
        {
            vcd::TransitionMultiBit t;
            t.timestamp = time;
            t.signal_index = sig_idx;
            t.string_offset = static_cast<uint32_t>(string_pool_.size());

            if (value[0] == 'b' || value[0] == 'B')
            {
                value++;
                len--;
            }

            t.string_length = len;
            string_pool_.insert(string_pool_.end(), value, value + len);
            res_multi_.push_back(t);
        }
    }

    static const char* varTypeStr(vcd::VarType t)
    {
        switch (t)
        {
            case vcd::VarType::Wire:
                return "wire";
            case vcd::VarType::Reg:
                return "reg";
            case vcd::VarType::Integer:
                return "integer";
            case vcd::VarType::Real:
                return "real";
            case vcd::VarType::Parameter:
                return "parameter";
            default:
                return "unknown";
        }
    }

    static json serializeScope(const vcd::ScopeNode* node)
    {
        json obj = {
            {"name", node->name},
            {"fullPath", node->full_path},
        };
        if (!node->signal_indices.empty())
        {
            obj["signals"] = node->signal_indices;
        }
        if (!node->children.empty())
        {
            json children = json::array();
            for (auto& child : node->children)
            {
                children.push_back(serializeScope(child.get()));
            }
            obj["children"] = std::move(children);
        }
        return obj;
    }
};

// ============================================================================
// Embind registration
// ============================================================================

EMSCRIPTEN_BINDINGS(vcd_parser_wasm)
{
    class_<VcdParserWasm>("VcdParser")
        .constructor<>()
        .function("close", &VcdParserWasm::close)
        .function("isOpen", &VcdParserWasm::isOpen)

        .function("open_file", &VcdParserWasm::open_file)
        .function("close_file", &VcdParserWasm::close_file)

        .function("begin_indexing", &VcdParserWasm::begin_indexing)
        .function("index_step", &VcdParserWasm::index_step)
        .function("finish_indexing", &VcdParserWasm::finish_indexing)

        .function("get_query_plan", &VcdParserWasm::get_query_plan)
        .function("begin_query", &VcdParserWasm::begin_query)
        .function("query_step", &VcdParserWasm::query_step)
        .function("cancel_query", &VcdParserWasm::cancel_query)
        .function("flush_query_binary", &VcdParserWasm::flush_query_binary)

        .function("getDate", &VcdParserWasm::getDate)
        .function("getVersion", &VcdParserWasm::getVersion)
        .function("getTimescaleMagnitude",
                  &VcdParserWasm::getTimescaleMagnitude)
        .function("getTimescaleUnit", &VcdParserWasm::getTimescaleUnit)
        .function("getTimeBegin", &VcdParserWasm::getTimeBegin)
        .function("getTimeEnd", &VcdParserWasm::getTimeEnd)
        .function("getSignalCount", &VcdParserWasm::getSignalCount)
        .function("getSnapshotCount", &VcdParserWasm::getSnapshotCount)
        .function("getIndexMemoryUsage", &VcdParserWasm::getIndexMemoryUsage)

        .function("getSignalsJSON", &VcdParserWasm::getSignalsJSON)
        .function("getHierarchyJSON", &VcdParserWasm::getHierarchyJSON)
        .function("findSignal", &VcdParserWasm::findSignal);

    class_<FstParserWasm>("FstParser")
        .constructor<>()
        .function("close", &FstParserWasm::close)
        .function("isOpen", &FstParserWasm::isOpen)

        .function("open_file", &FstParserWasm::open_file)
        .function("close_file", &FstParserWasm::close_file)

        .function("begin_indexing", &FstParserWasm::begin_indexing)
        .function("index_step", &FstParserWasm::index_step)
        .function("finish_indexing", &FstParserWasm::finish_indexing)

        .function("get_query_plan", &FstParserWasm::get_query_plan)
        .function("begin_query", &FstParserWasm::begin_query)
        .function("query_step", &FstParserWasm::query_step)
        .function("cancel_query", &FstParserWasm::cancel_query)
        .function("flush_query_binary", &FstParserWasm::flush_query_binary)

        .function("getDate", &FstParserWasm::getDate)
        .function("getVersion", &FstParserWasm::getVersion)
        .function("getTimescaleMagnitude",
                  &FstParserWasm::getTimescaleMagnitude)
        .function("getTimescaleUnit", &FstParserWasm::getTimescaleUnit)
        .function("getTimeBegin", &FstParserWasm::getTimeBegin)
        .function("getTimeEnd", &FstParserWasm::getTimeEnd)
        .function("getSignalCount", &FstParserWasm::getSignalCount)
        .function("getSnapshotCount", &FstParserWasm::getSnapshotCount)
        .function("getIndexMemoryUsage", &FstParserWasm::getIndexMemoryUsage)

        .function("getSignalsJSON", &FstParserWasm::getSignalsJSON)
        .function("getHierarchyJSON", &FstParserWasm::getHierarchyJSON)
        .function("findSignal", &FstParserWasm::findSignal);
}
