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

    void close()
    {
        if (chunk_buffer_)
        {
            std::free(chunk_buffer_);
            chunk_buffer_ = nullptr;
            chunk_capacity_ = 0;
        }
    }

    bool isOpen() const { return parser_.is_open(); }

    // --- Chunk Memory Allocation ---

    // Allocate contiguous WASM memory for the JS host to write directly into.
    uintptr_t allocate_chunk_buffer(size_t size)
    {
        if (size > chunk_capacity_)
        {
            if (chunk_buffer_) std::free(chunk_buffer_);
            chunk_buffer_ = static_cast<uint8_t*>(std::malloc(size + 1));
            chunk_capacity_ = size;
        }
        return reinterpret_cast<uintptr_t>(chunk_buffer_);
    }

    // --- Indexing Phase ---

    void begin_indexing() { parser_.begin_indexing(); }

    bool push_chunk_for_index(size_t size, uint64_t global_file_offset)
    {
        if (!chunk_buffer_ || size > chunk_capacity_) return false;
        return parser_.push_chunk_for_index(chunk_buffer_, size,
                                            global_file_offset);
    }

    void finish_indexing() { parser_.finish_indexing(); }

    // --- Query Phase ---

    emscripten::val get_query_plan(uint64_t start_time) const
    {
        vcd::QueryPlan plan = parser_.get_query_plan(start_time);
        auto obj = emscripten::val::object();
        obj.set("file_offset", val(plan.file_offset));
        obj.set("snapshot_time", val(plan.snapshot_time));
        obj.set("snapshot_index", val(static_cast<uint32_t>(plan.snapshot_index)));
        return obj;
    }

    void begin_query(uint64_t start_time, uint64_t end_time,
                     const std::string& indicesJSON, uint32_t snapshot_index)
    {
        auto parsed = json::parse(indicesJSON);
        std::vector<uint32_t> indices = parsed.get<std::vector<uint32_t>>();
        parser_.begin_query(start_time, end_time, indices,
                            static_cast<size_t>(snapshot_index));
    }

    bool push_chunk_for_query(size_t size)
    {
        if (!chunk_buffer_ || size > chunk_capacity_) return false;
        return parser_.push_chunk_for_query(chunk_buffer_, size);
    }

    // Return mapping addresses instead of JSON serialization
    emscripten::val finish_query_binary()
    {
        auto res = parser_.finish_query_binary();
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
    uint8_t* chunk_buffer_ = nullptr;
    size_t chunk_capacity_ = 0;

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
// Embind registration
// ============================================================================

EMSCRIPTEN_BINDINGS(vcd_parser_wasm)
{
    class_<VcdParserWasm>("VcdParser")
        .constructor<>()
        .function("close", &VcdParserWasm::close)
        .function("isOpen", &VcdParserWasm::isOpen)

        .function("allocate_chunk_buffer",
                  &VcdParserWasm::allocate_chunk_buffer)

        .function("begin_indexing", &VcdParserWasm::begin_indexing)
        .function("push_chunk_for_index", &VcdParserWasm::push_chunk_for_index)
        .function("finish_indexing", &VcdParserWasm::finish_indexing)

        .function("get_query_plan", &VcdParserWasm::get_query_plan)
        .function("begin_query", &VcdParserWasm::begin_query)
        .function("push_chunk_for_query", &VcdParserWasm::push_chunk_for_query)
        .function("finish_query_binary", &VcdParserWasm::finish_query_binary)

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
}
