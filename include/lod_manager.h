#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "waveform_parser.h"

namespace vcd
{

    /**
     * @brief Manages Level of Detail (LOD) and Glitch detection for waveform
     * parsers.
     */
    class LodManager
    {
       public:
        /**
         * @brief Initialize or reset the LOD manager.
         */
        void reset(size_t signal_count, float pixel_time_step);

        /**
         * @brief Process a 1-bit value change.
         */
        void process_1bit(uint64_t current_time, uint32_t sig_idx, uint8_t v,
                          uint8_t old_v, std::vector<Transition1Bit>& res_1bit,
                          std::vector<int64_t>& last_index_1bit);

        /**
         * @brief Process a multi-bit value change.
         */
        void process_multibit(uint64_t current_time, uint32_t sig_idx,
                              std::string_view val_tok,
                              const std::string& old_v,
                              std::vector<TransitionMultiBit>& res_multibit,
                              std::vector<int64_t>& last_index_multi,
                              std::string& query_string_pool);

        /**
         * @brief Helper to emit initial state without glitch checks.
         */
        void emit_initial_1bit(uint64_t start_time, uint32_t sig_idx, uint8_t v,
                               std::vector<Transition1Bit>& res_1bit,
                               std::vector<int64_t>& last_index_1bit);

        /**
         * @brief Helper to emit initial state without glitch checks.
         */
        void emit_initial_multibit(
            uint64_t start_time, uint32_t sig_idx, std::string_view sv,
            std::vector<TransitionMultiBit>& res_multibit,
            std::vector<int64_t>& last_index_multi,
            std::string& query_string_pool);

        /**
         * @brief Flush any open glitches at the end of a query.
         */
        void flush_glitches(std::vector<Transition1Bit>& res_1bit,
                            std::vector<int64_t>& last_index_1bit,
                            std::vector<TransitionMultiBit>& res_multibit,
                            std::vector<int64_t>& last_index_multi,
                            std::string& query_string_pool);

       private:
        float pixel_time_step_ = -1.0f;
        std::vector<uint64_t> last_emitted_time_;
        std::vector<bool> signal_is_glitch_;

        // Shadow state: the last EMITTED value (pre-glitch)
        std::vector<uint64_t> last_transition_time_;
        std::vector<uint8_t> last_value_1bit_;
        std::vector<uint32_t> last_value_multi_offset_;
        std::vector<uint32_t> last_value_multi_length_;

        // Glitch-end state: the actual current value during a glitch
        std::vector<uint32_t> glitch_end_multi_offset_;
        std::vector<uint32_t> glitch_end_multi_length_;

        uint32_t glitch_string_offset_ = static_cast<uint32_t>(-1);
    };

}  // namespace vcd
