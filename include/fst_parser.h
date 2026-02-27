#pragma once

#include <memory>
#include <string>
#include <vector>

#include "waveform_parser.h"

// Forward declaration of fstReaderContext
struct fstReaderContext;

namespace vcd
{
    class FstParser : public IWaveformParser
    {
       public:
        FstParser();
        ~FstParser() override;

        // Non-copyable
        FstParser(const FstParser&) = delete;
        FstParser& operator=(const FstParser&) = delete;

        // Move
        FstParser(FstParser&&) noexcept;
        FstParser& operator=(FstParser&&) noexcept;

        bool is_open() const override;

        // --- Metadata accessors ---
        const Timescale& timescale() const override;
        uint64_t time_begin() const override;
        uint64_t time_end() const override;
        size_t signal_count() const override;
        const std::string& date() const override;
        const std::string& version() const override;

        const std::vector<SignalDef>& signals() const override;
        const ScopeNode* root_scope() const override;
        const SignalDef* find_signal(
            const std::string& full_path) const override;

        // --- Indexing Phase ---
        bool open_file(const std::string& filepath) override;
        void close_file() override;
        void begin_indexing() override;
        size_t index_step(size_t chunk_size) override;
        void finish_indexing() override;

        // --- Query Phase ---
        QueryPlan get_query_plan(uint64_t start_time) const override;

        void begin_query(uint64_t start_time, uint64_t end_time,
                         const std::vector<uint32_t>& signal_indices,
                         size_t snapshot_index,
                         float pixel_time_step = -1.0f) override;

        bool query_step(size_t chunk_size) override;
        QueryResultBinary flush_query_binary() override;
        void cancel_query() override;

        // --- Statistics ---
        size_t snapshot_count() const override;
        size_t index_memory_usage() const override;

       private:
        struct Impl;
        std::unique_ptr<Impl> impl_;
    };
}  // namespace vcd
