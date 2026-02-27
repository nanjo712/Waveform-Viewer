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

    /// Waveform variable type
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

    /// Waveform variable direction
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
        std::string id_code;    // identifier code
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
    struct Snapshot
    {
        uint64_t time;         // Simulation time at snapshot
        uint64_t file_offset;  // Byte offset in the original file
        std::vector<uint64_t>
            packed_1bit_states;  // Bit-packed states (2 bits per value: 00=0,
                                 // 01=1, 10=x, 11=z)
        std::vector<std::string> multibit_states;
    };

    /// Tells the caller where to seek in the file and provides the snapshot
    /// index.
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
        uint8_t value;          // 0='0', 1='1', 2='x', 3='z', 4='GLITCH'
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
    // IWaveformParser Interface
    // ============================================================================

    class IWaveformParser
    {
       public:
        virtual ~IWaveformParser() = default;

        /// Whether a file is currently parsed (header complete)
        virtual bool is_open() const = 0;

        // --- Metadata accessors ---
        virtual const Timescale& timescale() const = 0;
        virtual uint64_t time_begin() const = 0;
        virtual uint64_t time_end() const = 0;
        virtual size_t signal_count() const = 0;
        virtual const std::string& date() const = 0;
        virtual const std::string& version() const = 0;

        /// Get all signal definitions.
        virtual const std::vector<SignalDef>& signals() const = 0;

        /// Get the root scope node.
        virtual const ScopeNode* root_scope() const = 0;

        /// Find a signal by its full hierarchical path (e.g. "top.cpu.clk").
        virtual const SignalDef* find_signal(
            const std::string& full_path) const = 0;

        // --- Indexing Phase ---
        virtual bool open_file(const std::string& filepath) = 0;
        virtual void close_file() = 0;
        virtual void begin_indexing() = 0;
        virtual size_t index_step(size_t chunk_size) = 0;
        virtual void finish_indexing() = 0;

        // --- Query Phase ---
        virtual QueryPlan get_query_plan(uint64_t start_time) const = 0;

        virtual void begin_query(uint64_t start_time, uint64_t end_time,
                                 const std::vector<uint32_t>& signal_indices,
                                 size_t snapshot_index,
                                 float pixel_time_step = -1.0f) = 0;

        virtual bool query_step(size_t chunk_size) = 0;
        virtual QueryResultBinary flush_query_binary() = 0;
        virtual void cancel_query() = 0;

        // --- Statistics ---
        virtual size_t snapshot_count() const = 0;
        virtual size_t index_memory_usage() const = 0;
    };

}  // namespace vcd
