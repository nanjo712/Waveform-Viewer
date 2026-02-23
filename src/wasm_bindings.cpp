#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdlib>
#include <cstring>
#include <sstream>
#include <string>
#include <vector>

#include "vcd_parser.h"

using namespace emscripten;

// ============================================================================
// WASM wrapper: owns a VcdParser + a copy of the file buffer in WASM heap
// ============================================================================

class VcdParserWasm {
   public:
    VcdParserWasm() = default;
    ~VcdParserWasm() { close(); }

    /// Parse VCD data from a JS Uint8Array.
    /// The data is copied into the WASM linear memory so the JS side can
    /// release its ArrayBuffer immediately after this call.
    bool parse(const std::string& data, uint32_t chunk_size) {
        close();

        buf_size_ = data.size();
        if (buf_size_ == 0) return false;

        buf_ = static_cast<char*>(std::malloc(buf_size_));
        if (!buf_) return false;
        std::memcpy(buf_, data.data(), buf_size_);

        if (!parser_.open_buffer(buf_, buf_size_, chunk_size)) {
            close();
            return false;
        }
        return true;
    }

    void close() {
        parser_.close();
        if (buf_) {
            std::free(buf_);
            buf_ = nullptr;
        }
        buf_size_ = 0;
    }

    bool isOpen() const { return parser_.is_open(); }

    // --- Metadata ---

    std::string getDate() const { return parser_.date(); }
    std::string getVersion() const { return parser_.version(); }

    uint32_t getTimescaleMagnitude() const {
        return static_cast<uint32_t>(parser_.timescale().magnitude);
    }

    std::string getTimescaleUnit() const {
        switch (parser_.timescale().unit) {
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

    // Use double for u64 since JS has no native u64
    double getTimeBegin() const {
        return static_cast<double>(parser_.time_begin());
    }
    double getTimeEnd() const {
        return static_cast<double>(parser_.time_end());
    }

    uint32_t getSignalCount() const {
        return static_cast<uint32_t>(parser_.signal_count());
    }
    uint32_t getChunkCount() const {
        return static_cast<uint32_t>(parser_.chunk_count());
    }
    uint32_t getTotalTransitions() const {
        return static_cast<uint32_t>(parser_.total_transitions());
    }
    double getFileSize() const {
        return static_cast<double>(parser_.file_size());
    }

    // --- Signal list as JSON ---
    // Returns: [{"name":"clk","fullPath":"top.clk","idCode":"!","width":1,"index":0,"type":"wire"}, ...]

    std::string getSignalsJSON() const {
        auto& sigs = parser_.signals();
        std::ostringstream os;
        os << '[';
        for (size_t i = 0; i < sigs.size(); ++i) {
            if (i > 0) os << ',';
            auto& s = sigs[i];
            os << "{\"name\":\"" << escapeJSON(s.name)
               << "\",\"fullPath\":\"" << escapeJSON(s.full_path)
               << "\",\"idCode\":\"" << escapeJSON(s.id_code)
               << "\",\"width\":" << s.width
               << ",\"index\":" << s.index
               << ",\"type\":\"" << varTypeStr(s.type) << '"';
            if (s.msb >= 0) {
                os << ",\"msb\":" << s.msb << ",\"lsb\":" << s.lsb;
            }
            os << '}';
        }
        os << ']';
        return os.str();
    }

    // --- Hierarchy as JSON ---
    // Returns: {"name":"<root>","children":[{"name":"top","signals":[0,1],"children":[...]}]}

    std::string getHierarchyJSON() const {
        auto* root = parser_.root_scope();
        if (!root) return "{}";
        std::ostringstream os;
        serializeScope(os, root);
        return os.str();
    }

    // --- Query ---
    // Returns JSON: {"tBegin":..., "tEnd":..., "signals":[
    //   {"index":0,"name":"top.clk","initialValue":"0","transitions":[[ts,"val"],...]}
    // ]}

    std::string query(double t_begin, double t_end,
                      const std::string& indicesJSON) const {
        // Parse indicesJSON: "[0,2,5]"
        std::vector<uint32_t> indices;
        parseIndicesJSON(indicesJSON, indices);

        auto result = parser_.query(static_cast<uint64_t>(t_begin),
                                     static_cast<uint64_t>(t_end), indices);

        std::ostringstream os;
        os << "{\"tBegin\":" << result.t_begin
           << ",\"tEnd\":" << result.t_end
           << ",\"signals\":[";

        for (size_t i = 0; i < result.signals.size(); ++i) {
            if (i > 0) os << ',';
            auto& sqr = result.signals[i];
            os << "{\"index\":" << sqr.signal_index
               << ",\"name\":\"" << escapeJSON(sqr.signal_name)
               << "\",\"initialValue\":\"" << escapeJSON(sqr.initial_value)
               << "\",\"transitions\":[";

            for (size_t j = 0; j < sqr.transitions.size(); ++j) {
                if (j > 0) os << ',';
                os << '[' << sqr.transitions[j].first
                   << ",\"" << escapeJSON(sqr.transitions[j].second) << "\"]";
            }
            os << "]}";
        }
        os << "]}";
        return os.str();
    }

    /// Convenience: query by signal paths
    std::string queryByPaths(double t_begin, double t_end,
                             const std::string& pathsJSON) const {
        // Parse pathsJSON: '["top.clk","top.cpu.data"]'
        std::vector<std::string> paths;
        parsePathsJSON(pathsJSON, paths);

        auto result = parser_.query(static_cast<uint64_t>(t_begin),
                                     static_cast<uint64_t>(t_end), paths);

        std::ostringstream os;
        os << "{\"tBegin\":" << result.t_begin
           << ",\"tEnd\":" << result.t_end
           << ",\"signals\":[";

        for (size_t i = 0; i < result.signals.size(); ++i) {
            if (i > 0) os << ',';
            auto& sqr = result.signals[i];
            os << "{\"index\":" << sqr.signal_index
               << ",\"name\":\"" << escapeJSON(sqr.signal_name)
               << "\",\"initialValue\":\"" << escapeJSON(sqr.initial_value)
               << "\",\"transitions\":[";

            for (size_t j = 0; j < sqr.transitions.size(); ++j) {
                if (j > 0) os << ',';
                os << '[' << sqr.transitions[j].first
                   << ",\"" << escapeJSON(sqr.transitions[j].second) << "\"]";
            }
            os << "]}";
        }
        os << "]}";
        return os.str();
    }

    /// Find signal index by full path. Returns -1 if not found.
    int findSignal(const std::string& fullPath) const {
        auto* sig = parser_.find_signal(fullPath);
        if (!sig) return -1;
        return static_cast<int>(sig->index);
    }

   private:
    vcd::VcdParser parser_;
    char* buf_ = nullptr;
    size_t buf_size_ = 0;

    // --- JSON helpers ---

    static std::string escapeJSON(const std::string& s) {
        std::string out;
        out.reserve(s.size());
        for (char c : s) {
            switch (c) {
                case '"':
                    out += "\\\"";
                    break;
                case '\\':
                    out += "\\\\";
                    break;
                case '\n':
                    out += "\\n";
                    break;
                case '\r':
                    out += "\\r";
                    break;
                case '\t':
                    out += "\\t";
                    break;
                default:
                    out += c;
            }
        }
        return out;
    }

    static const char* varTypeStr(vcd::VarType t) {
        switch (t) {
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

    static void serializeScope(std::ostringstream& os,
                                const vcd::ScopeNode* node) {
        os << "{\"name\":\"" << escapeJSON(node->name)
           << "\",\"fullPath\":\"" << escapeJSON(node->full_path) << '"';

        if (!node->signal_indices.empty()) {
            os << ",\"signals\":[";
            for (size_t i = 0; i < node->signal_indices.size(); ++i) {
                if (i > 0) os << ',';
                os << node->signal_indices[i];
            }
            os << ']';
        }

        if (!node->children.empty()) {
            os << ",\"children\":[";
            for (size_t i = 0; i < node->children.size(); ++i) {
                if (i > 0) os << ',';
                serializeScope(os, node->children[i].get());
            }
            os << ']';
        }

        os << '}';
    }

    static void parseIndicesJSON(const std::string& json,
                                  std::vector<uint32_t>& out) {
        // Simple parser for "[1,2,3]"
        size_t i = 0;
        while (i < json.size()) {
            if (json[i] >= '0' && json[i] <= '9') {
                uint32_t val = 0;
                while (i < json.size() && json[i] >= '0' && json[i] <= '9') {
                    val = val * 10 + (json[i] - '0');
                    ++i;
                }
                out.push_back(val);
            } else {
                ++i;
            }
        }
    }

    static void parsePathsJSON(const std::string& json,
                                std::vector<std::string>& out) {
        // Simple parser for '["a.b","c.d"]'
        size_t i = 0;
        while (i < json.size()) {
            if (json[i] == '"') {
                ++i;
                std::string s;
                while (i < json.size() && json[i] != '"') {
                    if (json[i] == '\\' && i + 1 < json.size()) {
                        ++i;
                    }
                    s += json[i];
                    ++i;
                }
                if (i < json.size()) ++i;  // skip closing "
                out.push_back(std::move(s));
            } else {
                ++i;
            }
        }
    }
};

// ============================================================================
// Embind registration
// ============================================================================

EMSCRIPTEN_BINDINGS(vcd_parser_wasm) {
    class_<VcdParserWasm>("VcdParser")
        .constructor<>()
        .function("parse", &VcdParserWasm::parse)
        .function("close", &VcdParserWasm::close)
        .function("isOpen", &VcdParserWasm::isOpen)
        .function("getDate", &VcdParserWasm::getDate)
        .function("getVersion", &VcdParserWasm::getVersion)
        .function("getTimescaleMagnitude",
                  &VcdParserWasm::getTimescaleMagnitude)
        .function("getTimescaleUnit", &VcdParserWasm::getTimescaleUnit)
        .function("getTimeBegin", &VcdParserWasm::getTimeBegin)
        .function("getTimeEnd", &VcdParserWasm::getTimeEnd)
        .function("getSignalCount", &VcdParserWasm::getSignalCount)
        .function("getChunkCount", &VcdParserWasm::getChunkCount)
        .function("getTotalTransitions", &VcdParserWasm::getTotalTransitions)
        .function("getFileSize", &VcdParserWasm::getFileSize)
        .function("getSignalsJSON", &VcdParserWasm::getSignalsJSON)
        .function("getHierarchyJSON", &VcdParserWasm::getHierarchyJSON)
        .function("query", &VcdParserWasm::query)
        .function("queryByPaths", &VcdParserWasm::queryByPaths)
        .function("findSignal", &VcdParserWasm::findSignal);
}
