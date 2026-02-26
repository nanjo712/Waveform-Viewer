#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include "fstapi.h"
#include "vcd_parser.h"

static const char* time_unit_str(vcd::TimeUnit u)
{
    switch (u)
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
    return "?";
}

static void print_scope(const vcd::ScopeNode* node, int depth,
                        const std::vector<vcd::SignalDef>& sigs)
{
    for (int i = 0; i < depth; ++i) std::printf("  ");
    std::printf("[scope] %s\n", node->name.c_str());

    for (auto idx : node->signal_indices)
    {
        for (int i = 0; i < depth + 1; ++i) std::printf("  ");
        std::printf("[signal] %s  (id=%s, width=%d, index=%u)\n",
                    sigs[idx].name.c_str(), sigs[idx].id_code.c_str(),
                    sigs[idx].width, sigs[idx].index);
    }

    for (auto& child : node->children)
    {
        print_scope(child.get(), depth + 1, sigs);
    }
}

int main(int argc, char* argv[])
{
    if (argc < 2)
    {
        std::fprintf(stderr,
                     "Usage: %s <file.vcd> [chunk_size_mb] [t_begin t_end "
                     "signal_path...]\n",
                     argv[0]);
        return 1;
    }

    const char* filepath = argv[1];
    std::string path_str(filepath);
    if (path_str.size() > 4 && path_str.substr(path_str.size() - 4) == ".fst")
    {
        std::printf("Opening FST file: %s\n", filepath);
        fstReaderContext* ctx = fstReaderOpen(filepath);
        if (!ctx)
        {
            std::fprintf(stderr, "Failed to open FST file: %s\n", filepath);
            return 1;
        }

        std::printf("\n=== FST File Info ===\n");
        std::printf("Date:             %s\n", fstReaderGetDateString(ctx));
        std::printf("Version:          %s\n", fstReaderGetVersionString(ctx));
        std::printf("Timescale:        1e%d s\n",
                    (int)fstReaderGetTimescale(ctx));
        std::printf("Time range:       [%lu, %lu]\n",
                    (unsigned long)fstReaderGetStartTime(ctx),
                    (unsigned long)fstReaderGetEndTime(ctx));
        std::printf("Variable count:   %lu\n",
                    (unsigned long)fstReaderGetVarCount(ctx));

        fstReaderClose(ctx);
        return 0;
    }

    uint64_t chunk_size_bytes = 32 * 1024 * 1024;  // 32 MB default
    if (argc >= 3)
    {
        chunk_size_bytes = std::strtoull(argv[2], nullptr, 10) * 1024 * 1024;
        if (chunk_size_bytes == 0) chunk_size_bytes = 1024 * 1024;  // min 1 MB
    }

    std::printf("Opening VCD file: %s for Indexing (chunk_size=%lu bytes)\n",
                filepath, (unsigned long)chunk_size_bytes);

    int fd = ::open(filepath, O_RDONLY);
    uint64_t file_total_size = 0;
    if (fd >= 0)
    {
        struct stat st;
        if (::fstat(fd, &st) == 0)
        {
            file_total_size = static_cast<uint64_t>(st.st_size);
        }
        ::close(fd);
    }

    vcd::VcdParser parser;
    if (!parser.open_file(filepath))
    {
        std::fprintf(stderr, "Failed to open file via VcdParser: %s\n",
                     filepath);
        return 1;
    }

    // =====================================================================
    // Phase 1: Indexing
    //   Read the entire file in chunks, build the signal hierarchy, and
    //   create sparse snapshots every ~10 MB.
    // =====================================================================
    auto t0 = std::chrono::high_resolution_clock::now();
    parser.begin_indexing();

    while (parser.index_step(chunk_size_bytes) > 0)
    {
        // Keep stepping until EOF
    }

    parser.finish_indexing();

    auto t1 = std::chrono::high_resolution_clock::now();
    double parse_ms =
        std::chrono::duration<double, std::milli>(t1 - t0).count();

    if (!parser.is_open())
    {
        std::fprintf(stderr, "Failed to parse VCD header.\n");
        return 1;
    }

    std::printf("\n=== VCD File Info ===\n");
    if (file_total_size > 0)
    {
        std::printf("File size:        %lu bytes\n",
                    (unsigned long)file_total_size);
    }
    std::printf("Index time:       %.2f ms\n", parse_ms);
    std::printf("Date:             %s\n", parser.date().c_str());
    std::printf("Version:          %s\n", parser.version().c_str());
    std::printf("Timescale:        %d%s\n", parser.timescale().magnitude,
                time_unit_str(parser.timescale().unit));
    std::printf("Time range:       [%lu, %lu]\n",
                (unsigned long)parser.time_begin(),
                (unsigned long)parser.time_end());
    std::printf("Signal count:     %zu\n", parser.signal_count());
    std::printf("Snapshot count:   %zu\n", parser.snapshot_count());
    std::printf("Index Mem Usage:  %zu bytes\n", parser.index_memory_usage());

    std::printf("\n=== Signal Hierarchy ===\n");
    if (parser.root_scope())
    {
        print_scope(parser.root_scope(), 0, parser.signals());
    }

    // =====================================================================
    // Phase 2: Querying
    //   Given a time range [t_begin, t_end] and a set of signal paths:
    //   1. get_query_plan()  -> binary-search snapshots for the nearest
    //                          snapshot <= t_begin, get file_offset
    //   2. Use file_offset as start in the mmap'd region (no seek needed)
    //   3. begin_query()     -> restore state from the snapshot
    //   4. push_chunk_for_query() in a loop; stop as soon as it returns
    //      false (current_time > t_end)
    //   5. finish_query_binary() -> get the results
    // =====================================================================
    if (argc >= 6)
    {
        uint64_t qb = std::strtoull(argv[3], nullptr, 10);
        uint64_t qe = std::strtoull(argv[4], nullptr, 10);

        std::vector<uint32_t> query_ids;
        for (int i = 5; i < argc; ++i)
        {
            const vcd::SignalDef* sig = parser.find_signal(argv[i]);
            if (sig)
            {
                query_ids.push_back(sig->index);
            }
            else
            {
                std::printf("Warning: Signal '%s' not found.\n", argv[i]);
            }
        }

        std::printf("\n=== Query [%lu, %lu] ===\n", (unsigned long)qb,
                    (unsigned long)qe);

        auto qt0 = std::chrono::high_resolution_clock::now();

        // Step 1: Get the query plan (binary search for nearest snapshot)
        vcd::QueryPlan plan = parser.get_query_plan(qb);
        std::printf("Query plan: snapshot time %lu, index %zu...\n",
                    (unsigned long)plan.snapshot_time, plan.snapshot_index);

        // Step 2: Begin the query (restores snapshot state internally and
        // seeks)
        parser.begin_query(qb, qe, query_ids, plan.snapshot_index);

        // Step 3: Walk chunks
        while (parser.query_step(chunk_size_bytes))
        {
            // Keep stepping until query ends
        }

        // Step 4: Finalize and get results
        vcd::QueryResultBinary res = parser.flush_query_binary();

        auto qt1 = std::chrono::high_resolution_clock::now();
        double query_us =
            std::chrono::duration<double, std::micro>(qt1 - qt0).count();
        std::printf("Query time:       %.2f us\n", query_us);

        std::printf("\nResults:\n");
        std::printf("  1-bit items: %zu\n", res.count_1bit);
        for (size_t i = 0; i < res.count_1bit; ++i)
        {
            const auto& tr = res.transitions_1bit[i];
            const auto& sig = parser.signals()[tr.signal_index];
            char v = (tr.value == 0)   ? '0'
                     : (tr.value == 1) ? '1'
                     : (tr.value == 2) ? 'x'
                                       : 'z';
            std::printf("    t=%lu  %s = %c\n", (unsigned long)tr.timestamp,
                        sig.full_path.c_str(), v);
        }

        std::printf("  Multi-bit items: %zu\n", res.count_multibit);
        for (size_t i = 0; i < res.count_multibit; ++i)
        {
            const auto& tr = res.transitions_multibit[i];
            const auto& sig = parser.signals()[tr.signal_index];
            std::string_view sval(res.string_pool + tr.string_offset,
                                  tr.string_length);
            std::printf("    t=%lu  %s = %.*s\n", (unsigned long)tr.timestamp,
                        sig.full_path.c_str(), (int)sval.size(), sval.data());
        }
    }

    return 0;
}
