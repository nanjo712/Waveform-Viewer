#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

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
                     "Usage: %s <file.vcd> [chunk_size] [t_begin t_end "
                     "signal_path...]\n",
                     argv[0]);
        std::fprintf(stderr, "\nExamples:\n");
        std::fprintf(
            stderr,
            "  %s test.vcd                           # parse and show info\n",
            argv[0]);
        std::fprintf(stderr,
                     "  %s test.vcd 1000                      # parse with "
                     "chunk_size=1000\n",
                     argv[0]);
        std::fprintf(stderr,
                     "  %s test.vcd 1000 0 100 top.clk        # query top.clk "
                     "in [0,100]\n",
                     argv[0]);
        return 1;
    }

    const char* filepath = argv[1];
    uint64_t chunk_size = 10000;
    if (argc >= 3) chunk_size = std::strtoull(argv[2], nullptr, 10);

    std::printf("Opening VCD file: %s  (chunk_size=%lu)\n", filepath,
                (unsigned long)chunk_size);

    vcd::VcdParser parser;

    auto t0 = std::chrono::high_resolution_clock::now();
    bool ok = parser.open(filepath, chunk_size);
    auto t1 = std::chrono::high_resolution_clock::now();

    if (!ok)
    {
        std::fprintf(stderr, "Failed to open/parse VCD file.\n");
        return 1;
    }

    double parse_ms =
        std::chrono::duration<double, std::milli>(t1 - t0).count();

    std::printf("\n=== VCD File Info ===\n");
    std::printf("File size:        %zu bytes\n", parser.file_size());
    std::printf("Parse time:       %.2f ms\n", parse_ms);
    std::printf("Date:             %s\n", parser.date().c_str());
    std::printf("Version:          %s\n", parser.version().c_str());
    std::printf("Timescale:        %d%s\n", parser.timescale().magnitude,
                time_unit_str(parser.timescale().unit));
    std::printf("Time range:       [%lu, %lu]\n",
                (unsigned long)parser.time_begin(),
                (unsigned long)parser.time_end());
    std::printf("Signal count:     %zu\n", parser.signal_count());
    std::printf("Total transitions:%zu\n", parser.total_transitions());
    std::printf("Chunk count:      %zu\n", parser.chunk_count());

    std::printf("\n=== Signal Hierarchy ===\n");
    if (parser.root_scope())
    {
        print_scope(parser.root_scope(), 0, parser.signals());
    }

    // If query parameters are provided
    if (argc >= 6)
    {
        uint64_t qb = std::strtoull(argv[3], nullptr, 10);
        uint64_t qe = std::strtoull(argv[4], nullptr, 10);

        std::vector<std::string> paths;
        for (int i = 5; i < argc; ++i) paths.emplace_back(argv[i]);

        std::printf("\n=== Query [%lu, %lu] ===\n", (unsigned long)qb,
                    (unsigned long)qe);

        auto qt0 = std::chrono::high_resolution_clock::now();
        auto result = parser.query(qb, qe, paths);
        auto qt1 = std::chrono::high_resolution_clock::now();

        double query_us =
            std::chrono::duration<double, std::micro>(qt1 - qt0).count();
        std::printf("Query time: %.2f us\n\n", query_us);

        for (auto& sqr : result.signals)
        {
            std::printf("Signal: %s (index=%u)\n", sqr.signal_name.c_str(),
                        sqr.signal_index);
            std::printf("  Initial value at t=%lu: %s\n", (unsigned long)qb,
                        sqr.initial_value.c_str());
            std::printf("  Transitions in range:\n");
            for (auto& [ts, val] : sqr.transitions)
            {
                std::printf("    t=%lu  -> %s\n", (unsigned long)ts,
                            val.c_str());
            }
            std::printf("\n");
        }
    }

    parser.close();
    return 0;
}
