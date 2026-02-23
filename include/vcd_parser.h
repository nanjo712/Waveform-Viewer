#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace vcd
{

    // ============================================================================
    // Data Structures
    // ============================================================================

    /// VCD variable type
    enum class VarType : uint8_t
    {
        Wire,
        Reg,
        Integer,
        Real,
        Parameter,
        Event,
        Supply0,
        Supply1,
        Tri,
        TriAnd,
        TriOr,
        TriReg,
        Tri0,
        Tri1,
        WAnd,
        WOr,
        Unknown
    };

    /// VCD variable direction
    enum class VarDirection : uint8_t
    {
        Input,
        Output,
        InOut,
        Internal,
        Unknown
    };

    /// Timescale unit
    enum class TimeUnit : uint8_t
    {
        S,   // seconds
        MS,  // milliseconds
        US,  // microseconds
        NS,  // nanoseconds
        PS,  // picoseconds
        FS   // femtoseconds
    };

    /// Signal definition (from header)
    struct SignalDef
    {
        std::string name;       // signal name (leaf)
        std::string full_path;  // full hierarchical path, e.g. "top.cpu.clk"
        std::string id_code;    // VCD identifier code (e.g. "!", "#", "$a")
        VarType type = VarType::Unknown;
        int width = 1;  // bit width
        int msb = -1;   // bit range
        int lsb = -1;
        uint32_t index = 0;  // index into flat signal array
    };

    /// Scope node for hierarchy tree
    struct ScopeNode
    {
        std::string name;
        std::string full_path;
        ScopeNode* parent = nullptr;
        std::vector<std::unique_ptr<ScopeNode>> children;
        std::vector<uint32_t> signal_indices;  // indices into SignalDef array
    };

    /// Timescale info
    struct Timescale
    {
        int magnitude = 1;  // e.g. 1, 10, 100
        TimeUnit unit = TimeUnit::NS;
    };

    /// A single value-change transition recorded during pre-scan
    struct Transition
    {
        uint64_t timestamp;
        size_t
            file_offset;  // byte offset in the mmap'd file for this value line
        uint16_t
            line_len;  // length of the value-change line (to avoid re-scanning)
    };

    /// Per-signal transition list
    struct SignalTransitions
    {
        std::vector<Transition> transitions;
    };

    /// A snapshot of all signals' values at a chunk boundary
    struct ChunkSnapshot
    {
        uint64_t timestamp;
        /// For each signal (by index): the value string at this timestamp.
        /// For 1-bit signals: "0", "1", "x", "z"
        /// For multi-bit: "b0101", etc.
        std::vector<std::string> values;
        /// For each signal: the index into its transition list pointing
        /// to the first transition >= this chunk's timestamp.
        std::vector<uint32_t> transition_cursors;
    };

    /// Result for a single signal in a time-range query
    struct SignalQueryResult
    {
        uint32_t signal_index;
        std::string signal_name;
        std::string initial_value;  // value at t_begin
        /// (timestamp, new_value) pairs within [t_begin, t_end]
        std::vector<std::pair<uint64_t, std::string>> transitions;
    };

    /// Result for a time-range query
    struct QueryResult
    {
        uint64_t t_begin;
        uint64_t t_end;
        std::vector<SignalQueryResult> signals;
    };

    // ============================================================================
    // VcdParser - main interface
    // ============================================================================

    class VcdParser
    {
       public:
        VcdParser();
        ~VcdParser();

        // Non-copyable
        VcdParser(const VcdParser&) = delete;
        VcdParser& operator=(const VcdParser&) = delete;

        // Move
        VcdParser(VcdParser&&) noexcept;
        VcdParser& operator=(VcdParser&&) noexcept;

        /// Open and parse a VCD file (native: uses mmap).
        /// @param filepath   Path to the .vcd file
        /// @param chunk_size Chunk size in simulation time units for snapshot
        /// indexing.
        ///                   Smaller = more memory, faster random queries.
        ///                   Larger  = less memory, slower random queries.
        /// @return true on success
        bool open(const std::string& filepath, uint64_t chunk_size = 10000);

        /// Open and parse from an in-memory buffer (for WASM / embedded use).
        /// The caller must keep the buffer alive until close() is called.
        /// @param buf        Pointer to VCD file content in memory
        /// @param size       Size of the buffer in bytes
        /// @param chunk_size Chunk size in simulation time units
        /// @return true on success
        bool open_buffer(const char* buf, size_t size,
                         uint64_t chunk_size = 10000);

        /// Close file and release resources.
        void close();

        /// Whether a file is currently open and parsed.
        bool is_open() const;

        // --- Metadata accessors ---

        const Timescale& timescale() const;
        uint64_t time_begin() const;
        uint64_t time_end() const;
        size_t signal_count() const;
        const std::string& date() const;
        const std::string& version() const;

        /// Get all signal definitions.
        const std::vector<SignalDef>& signals() const;

        /// Get the root scope node.
        const ScopeNode* root_scope() const;

        /// Find a signal by its full hierarchical path (e.g. "top.cpu.clk").
        /// Returns nullptr if not found.
        const SignalDef* find_signal(const std::string& full_path) const;

        /// Find signal index by id code.
        /// Returns UINT32_MAX if not found.
        uint32_t find_signal_by_id(const std::string& id_code) const;

        // --- Query interface ---

        /// Query signal values within a time range.
        /// @param t_begin     Start time (inclusive)
        /// @param t_end       End time (inclusive)
        /// @param signal_indices  List of signal indices to query
        /// @return QueryResult with initial values and transitions in range
        QueryResult query(uint64_t t_begin, uint64_t t_end,
                          const std::vector<uint32_t>& signal_indices) const;

        /// Convenience: query by signal paths.
        QueryResult query(uint64_t t_begin, uint64_t t_end,
                          const std::vector<std::string>& signal_paths) const;

        // --- Statistics ---
        size_t file_size() const;
        size_t chunk_count() const;
        size_t total_transitions() const;

       private:
        struct Impl;
        std::unique_ptr<Impl> impl_;
    };

}  // namespace vcd
