#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdlib>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

#include "fst_parser.h"
#include "vcd_parser.h"

using namespace emscripten;
using json = nlohmann::json;

// ============================================================================
// WASM wrapper: operates on 0-copy binary chunks and high-precision BigInts
// Consolidates logic for any IWaveformParser implementation
// ============================================================================

template <typename ParserType>
class WaveformParserWasm
{
   public:
    WaveformParserWasm() : parser_(std::make_unique<ParserType>()) {}
    ~WaveformParserWasm() { parser_->close_file(); }

    void close() { parser_->close_file(); }
    bool isOpen() const { return parser_->is_open(); }

    // --- File I/O ---
    bool open_file(const std::string& filepath)
    {
        return parser_->open_file(filepath);
    }
    void close_file() { parser_->close_file(); }

    // --- Indexing Phase ---
    void begin_indexing() { parser_->begin_indexing(); }
    size_t index_step(size_t chunk_size)
    {
        return parser_->index_step(chunk_size);
    }
    void finish_indexing() { parser_->finish_indexing(); }

    // --- Query Phase ---
    emscripten::val get_query_plan(uint64_t start_time) const
    {
        vcd::QueryPlan plan = parser_->get_query_plan(start_time);
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
        parser_->begin_query(start_time, end_time, indices,
                             static_cast<size_t>(snapshot_index),
                             pixel_time_step);
    }

    bool query_step(size_t chunk_size)
    {
        return parser_->query_step(chunk_size);
    }
    void cancel_query() { parser_->cancel_query(); }

    emscripten::val flush_query_binary()
    {
        auto res = parser_->flush_query_binary();
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
    std::string getDate() const { return parser_->date(); }
    std::string getVersion() const { return parser_->version(); }

    uint32_t getTimescaleMagnitude() const
    {
        return static_cast<uint32_t>(parser_->timescale().magnitude);
    }

    std::string getTimescaleUnit() const
    {
        switch (parser_->timescale().unit)
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
            default:
                return "ns";
        }
    }

    uint64_t getTimeBegin() const { return parser_->time_begin(); }
    uint64_t getTimeEnd() const { return parser_->time_end(); }
    uint32_t getSignalCount() const
    {
        return static_cast<uint32_t>(parser_->signal_count());
    }
    uint32_t getSnapshotCount() const
    {
        return static_cast<uint32_t>(parser_->snapshot_count());
    }
    uint32_t getIndexMemoryUsage() const
    {
        return static_cast<uint32_t>(parser_->index_memory_usage());
    }

    // --- Signal list as JSON ---
    std::string getSignalsJSON() const
    {
        auto& sigs = parser_->signals();
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
        auto* root = parser_->root_scope();
        if (!root) return "{}";
        return serializeScope(root).dump();
    }

    int findSignal(const std::string& fullPath) const
    {
        auto* sig = parser_->find_signal(fullPath);
        if (!sig) return -1;
        return static_cast<int>(sig->index);
    }

   private:
    std::unique_ptr<vcd::IWaveformParser> parser_;

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
        json obj = {{"name", node->name}, {"fullPath", node->full_path}};
        if (!node->signal_indices.empty())
            obj["signals"] = node->signal_indices;
        if (!node->children.empty())
        {
            json children = json::array();
            for (auto& child : node->children)
                children.push_back(serializeScope(child.get()));
            obj["children"] = std::move(children);
        }
        return obj;
    }
};

using VcdParserWasm = WaveformParserWasm<vcd::VcdParser>;
using FstParserWasm = WaveformParserWasm<vcd::FstParser>;

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
