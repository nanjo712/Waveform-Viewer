#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
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
        S,
        MS,
        US,
        NS,
        PS,
        FS
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
        uint32_t bit_index =
            UINT32_MAX;  // Index for 1-bit state (valid if width==1)
        uint32_t str_index =
            UINT32_MAX;  // Index for multi-bit state (valid if width>1)
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

    // ============================================================================
    // Sparse Indexing & Snapshot Structures
    // ============================================================================

    /// Compressed snapshot of the simulation state at a specific time.
    /// Created every ~10 MB of file data during the indexing phase.
    struct Snapshot
    {
        uint64_t time;         // Simulation time at snapshot
        uint64_t file_offset;  // Byte offset in the original VCD file of
                               // the '#' timestamp line that begins this time
        std::vector<uint64_t>
            packed_1bit_states;  // Bit-packed states (2 bits per value: 00=0,
                                 // 01=1, 10=x, 11=z)
        std::vector<std::string> multibit_states;
    };

    /// Returned by get_query_plan(): tells the caller where to seek in the
    /// file and provides the snapshot index so begin_query() can restore
    /// internal state from that snapshot.
    struct QueryPlan
    {
        uint64_t file_offset;    // Byte offset to fseek() to
        uint64_t snapshot_time;  // Simulation time of the snapshot
        size_t snapshot_index;   // Index into internal snapshot array
    };

    // ============================================================================
    // Binary Transfer Structures (Zero-copy JS Interop)
    // ============================================================================

    /// 1-bit values (efficient packing for plotting flags)
    struct alignas(8) Transition1Bit
    {
        uint64_t timestamp;
        uint32_t signal_index;  // Original SignalDef index
        uint8_t value;          // 0='0', 1='1', 2='x', 3='z'
        uint8_t padding[3];
    };

    /// Multi-bit values (points into string_pool)
    struct alignas(8) TransitionMultiBit
    {
        uint64_t timestamp;
        uint32_t signal_index;  // Original SignalDef index
        uint32_t string_offset;
        uint32_t string_length;
        uint32_t padding;  // Keep 8-byte aligned
    };

    /// Memory structure passed back to JS/WASM seamlessly
    struct QueryResultBinary
    {
        const Transition1Bit* transitions_1bit;
        size_t count_1bit;

        const TransitionMultiBit* transitions_multibit;
        size_t count_multibit;

        const char* string_pool;  // Contiguous block of multi-bit strings
        size_t string_pool_size;
    };

    // ============================================================================
    // VcdParser - main interface
    //
    // Workflow:
    //   Phase 1 (Indexing):
    //     begin_indexing()
    //     while (has data) push_chunk_for_index(data, size, file_offset)
    //     finish_indexing()
    //
    //   Phase 2 (Query, repeatable):
    //     plan = get_query_plan(start_time)
    //     begin_query(start_time, end_time, signal_indices,
    //     plan.snapshot_index) fseek(file, plan.file_offset) while (has data) {
    //       if (!push_chunk_for_query(data, size)) break;  // early-stop
    //     }
    //     result = finish_query_binary()
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

        /// Whether a file is currently parsed (header complete)
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

        // --- Indexing Phase ---

        /// Open a VCD file using standard fopen
        bool open_file(const std::string& filepath);

        /// Close the currently opened file
        void close_file();

        /// Start indexing phase. Resets all internal state.
        void begin_indexing();

        /// Repeatedly call to read and process chunks of the file.
        /// @return Number of bytes read in this step (0 means EOF or error)
        size_t index_step(size_t chunk_size);

        /// Finalize indexing. Creates a final snapshot if needed.
        void finish_indexing();

        // --- Query Phase ---

        /// Binary-search the snapshot list to find the best starting point
        /// for a query starting at `start_time`.
        /// Returns a QueryPlan with file_offset, snapshot_time, and
        /// snapshot_index. The caller should fseek() to file_offset and pass
        /// snapshot_index to begin_query().
        QueryPlan get_query_plan(uint64_t start_time) const;

        /// Prepare a query for signals in [start_time, end_time].
        /// Restores internal state from the snapshot at `snapshot_index`.
        /// @param start_time      Start of the query time window
        /// @param end_time        End of the query time window
        /// @param signal_indices  Indices of signals to query
        /// @param snapshot_index  Index from QueryPlan::snapshot_index
        /// @param pixel_time_step Downsampling resolution (time/pixel). < 0
        /// implies LOD disabled.
        void begin_query(uint64_t start_time, uint64_t end_time,
                         const std::vector<uint32_t>& signal_indices,
                         size_t snapshot_index, float pixel_time_step = -1.0f);

        /// Step-based query execution for non-blocking iteration.
        /// @return true if the query is still ongoing (needs more steps)
        /// @return false if the query window has been fully covered or EOF reached
        bool query_step(size_t chunk_size);

        /// Extract the query results accumulated so far as flat binary arrays,
        /// and clear the internal result buffers for the next chunk (streaming
        /// mode). The returned pointers are valid until the next
        /// push_chunk_for_query, flush_query_binary, begin_query, or
        /// destruction.
        QueryResultBinary flush_query_binary();

        // --- Statistics ---
        size_t snapshot_count() const;
        size_t index_memory_usage() const;

        /// Cancel an ongoing query
        void cancel_query();

       private:
        struct Impl;
        std::unique_ptr<Impl> impl_;
    };

}  // namespace vcd
