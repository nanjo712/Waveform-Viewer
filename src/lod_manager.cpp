#include "lod_manager.h"

#include <limits>

namespace vcd
{

    void LodManager::reset(size_t signal_count, float pixel_time_step)
    {
        pixel_time_step_ = pixel_time_step;
        last_emitted_time_.assign(signal_count,
                                  std::numeric_limits<uint64_t>::max());
        signal_is_glitch_.assign(signal_count, false);

        last_transition_time_.assign(signal_count,
                                     std::numeric_limits<uint64_t>::max());
        last_value_1bit_.assign(signal_count, 0);
        last_value_multi_offset_.assign(signal_count, 0);
        last_value_multi_length_.assign(signal_count, 0);

        glitch_end_multi_offset_.assign(signal_count, 0);
        glitch_end_multi_length_.assign(signal_count, 0);

        glitch_string_offset_ = static_cast<uint32_t>(-1);
    }

    void LodManager::process_1bit(uint64_t current_time, uint32_t sig_idx,
                                  uint8_t v, uint8_t old_v,
                                  std::vector<Transition1Bit>& res_1bit,
                                  std::vector<int64_t>& last_index_1bit)
    {
        if (current_time == last_emitted_time_[sig_idx])
        {
            // Same timestamp: just update the value of the existing transition
            int64_t last_idx = last_index_1bit[sig_idx];
            if (last_idx >= 0)
            {
                res_1bit[last_idx].value = v;
            }
        }
        else if (pixel_time_step_ > 0.0f &&
                 last_transition_time_[sig_idx] !=
                     std::numeric_limits<uint64_t>::max() &&
                 (current_time - last_transition_time_[sig_idx]) <
                     static_cast<uint64_t>(pixel_time_step_))
        {
            // Glitch detected: mark the PREVIOUS transition as GLITCH if value
            // changed
            if (v != old_v && !signal_is_glitch_[sig_idx])
            {
                int64_t last_idx = last_index_1bit[sig_idx];
                if (last_idx >= 0)
                {
                    res_1bit[last_idx].value = 4;  // GLITCH
                }
                signal_is_glitch_[sig_idx] = true;
            }
        }
        else if (v != old_v || signal_is_glitch_[sig_idx])
        {
            // Close the glitch at the last known transition time,
            // if we are currently glitching.
            if (signal_is_glitch_[sig_idx])
            {
                last_index_1bit[sig_idx] =
                    static_cast<int64_t>(res_1bit.size());
                res_1bit.push_back({last_transition_time_[sig_idx],
                                    sig_idx,
                                    old_v,
                                    {0, 0, 0}});
                last_emitted_time_[sig_idx] = last_transition_time_[sig_idx];
                signal_is_glitch_[sig_idx] = false;
            }

            // Only append the new transition if the value actually changed
            if (v != old_v)
            {
                last_index_1bit[sig_idx] =
                    static_cast<int64_t>(res_1bit.size());
                res_1bit.push_back({current_time, sig_idx, v, {0, 0, 0}});
                last_emitted_time_[sig_idx] = current_time;
            }
        }

        // Always track the actual transition time and value
        last_transition_time_[sig_idx] = current_time;
        last_value_1bit_[sig_idx] = v;
    }

    void LodManager::process_multibit(
        uint64_t current_time, uint32_t sig_idx, std::string_view val_tok,
        const std::string& old_v, std::vector<TransitionMultiBit>& res_multibit,
        std::vector<int64_t>& last_index_multi, std::string& query_string_pool)
    {
        if (current_time == last_emitted_time_[sig_idx])
        {
            // Same timestamp: update existing transition in multi-bit
            int64_t last_idx = last_index_multi[sig_idx];
            if (last_idx >= 0)
            {
                uint32_t offset =
                    static_cast<uint32_t>(query_string_pool.size());
                query_string_pool.append(val_tok);
                res_multibit[last_idx].string_offset = offset;
                res_multibit[last_idx].string_length =
                    static_cast<uint32_t>(val_tok.size());
                // Keep shadow in sync with the updated transition
                last_value_multi_offset_[sig_idx] = offset;
                last_value_multi_length_[sig_idx] =
                    static_cast<uint32_t>(val_tok.size());
            }
        }
        else if (pixel_time_step_ > 0.0f &&
                 last_transition_time_[sig_idx] !=
                     std::numeric_limits<uint64_t>::max() &&
                 (current_time - last_transition_time_[sig_idx]) <
                     static_cast<uint64_t>(pixel_time_step_))
        {
            // Glitch detected for multi-bit
            if (val_tok != old_v && !signal_is_glitch_[sig_idx])
            {
                if (glitch_string_offset_ == static_cast<uint32_t>(-1))
                {
                    glitch_string_offset_ =
                        static_cast<uint32_t>(query_string_pool.size());
                    query_string_pool.append("GLITCH");
                }
                // Push GLITCH as a NEW transition instead of overwriting
                // the previous one.
                last_index_multi[sig_idx] =
                    static_cast<int64_t>(res_multibit.size());
                res_multibit.push_back({last_transition_time_[sig_idx], sig_idx,
                                        glitch_string_offset_, 6, 0});
                last_emitted_time_[sig_idx] = last_transition_time_[sig_idx];
                signal_is_glitch_[sig_idx] = true;
            }

            // Track the actual current value during the glitch so the
            // closing transition uses the LATEST value, not the pre-glitch
            // shadow. This is critical for wide signals: without this,
            // after a glitch the display would revert to the pre-glitch
            // value instead of showing the actual current value.
            {
                uint32_t offset =
                    static_cast<uint32_t>(query_string_pool.size());
                query_string_pool.append(val_tok);
                glitch_end_multi_offset_[sig_idx] = offset;
                glitch_end_multi_length_[sig_idx] =
                    static_cast<uint32_t>(val_tok.size());
            }
        }
        else if (val_tok != old_v || signal_is_glitch_[sig_idx])
        {
            // Close the glitch at the last known transition time,
            // if we are currently glitching.
            if (signal_is_glitch_[sig_idx])
            {
                // Use the actual last value seen during the glitch
                // (glitch_end_*), NOT the pre-glitch shadow
                // (last_value_multi_*).
                last_index_multi[sig_idx] =
                    static_cast<int64_t>(res_multibit.size());
                res_multibit.push_back({last_transition_time_[sig_idx], sig_idx,
                                        glitch_end_multi_offset_[sig_idx],
                                        glitch_end_multi_length_[sig_idx], 0});
                last_emitted_time_[sig_idx] = last_transition_time_[sig_idx];
                signal_is_glitch_[sig_idx] = false;

                // Update the shadow to the glitch-end value
                last_value_multi_offset_[sig_idx] =
                    glitch_end_multi_offset_[sig_idx];
                last_value_multi_length_[sig_idx] =
                    glitch_end_multi_length_[sig_idx];
            }

            // Only append the new transition if the value actually changed
            if (val_tok != old_v)
            {
                uint32_t offset =
                    static_cast<uint32_t>(query_string_pool.size());
                query_string_pool.append(val_tok);
                last_index_multi[sig_idx] =
                    static_cast<int64_t>(res_multibit.size());
                res_multibit.push_back({current_time, sig_idx, offset,
                                        static_cast<uint32_t>(val_tok.size()),
                                        0});

                // Track the shadow value offsets
                last_value_multi_offset_[sig_idx] = offset;
                last_value_multi_length_[sig_idx] =
                    static_cast<uint32_t>(val_tok.size());
                last_emitted_time_[sig_idx] = current_time;
            }
        }

        // Always track the actual transition time
        last_transition_time_[sig_idx] = current_time;
    }

    void LodManager::emit_initial_1bit(uint64_t start_time, uint32_t sig_idx,
                                       uint8_t v,
                                       std::vector<Transition1Bit>& res_1bit,
                                       std::vector<int64_t>& last_index_1bit)
    {
        last_index_1bit[sig_idx] = static_cast<int64_t>(res_1bit.size());
        res_1bit.push_back({start_time, sig_idx, v, {0, 0, 0}});
        last_emitted_time_[sig_idx] = start_time;
        last_transition_time_[sig_idx] = start_time;
        last_value_1bit_[sig_idx] = v;
        signal_is_glitch_[sig_idx] = false;
    }

    void LodManager::emit_initial_multibit(
        uint64_t start_time, uint32_t sig_idx, std::string_view sv,
        std::vector<TransitionMultiBit>& res_multibit,
        std::vector<int64_t>& last_index_multi, std::string& query_string_pool)
    {
        uint32_t offset = static_cast<uint32_t>(query_string_pool.size());
        query_string_pool.append(sv);
        last_index_multi[sig_idx] = static_cast<int64_t>(res_multibit.size());
        res_multibit.push_back(
            {start_time, sig_idx, offset, static_cast<uint32_t>(sv.size()), 0});

        last_emitted_time_[sig_idx] = start_time;
        last_transition_time_[sig_idx] = start_time;
        last_value_multi_offset_[sig_idx] = offset;
        last_value_multi_length_[sig_idx] = static_cast<uint32_t>(sv.size());
        signal_is_glitch_[sig_idx] = false;
    }

    void LodManager::flush_glitches(
        std::vector<Transition1Bit>& res_1bit,
        std::vector<int64_t>& last_index_1bit,
        std::vector<TransitionMultiBit>& res_multibit,
        std::vector<int64_t>& last_index_multi, std::string& query_string_pool)
    {
        for (size_t sig_idx = 0; sig_idx < signal_is_glitch_.size(); ++sig_idx)
        {
            if (signal_is_glitch_[sig_idx])
            {
                if (sig_idx < last_value_1bit_.size() &&
                    last_index_1bit[sig_idx] != -1)
                {
                    // 1-bit signal
                    last_index_1bit[sig_idx] =
                        static_cast<int64_t>(res_1bit.size());
                    res_1bit.push_back({last_transition_time_[sig_idx],
                                        static_cast<uint32_t>(sig_idx),
                                        last_value_1bit_[sig_idx],
                                        {0, 0, 0}});
                }
                else if (sig_idx < glitch_end_multi_offset_.size() &&
                         last_index_multi[sig_idx] != -1)
                {
                    // Multi-bit signal: use glitch-end value (actual
                    // current value), not the pre-glitch shadow
                    last_index_multi[sig_idx] =
                        static_cast<int64_t>(res_multibit.size());
                    res_multibit.push_back({last_transition_time_[sig_idx],
                                            static_cast<uint32_t>(sig_idx),
                                            glitch_end_multi_offset_[sig_idx],
                                            glitch_end_multi_length_[sig_idx],
                                            0});
                }
                signal_is_glitch_[sig_idx] = false;
                last_emitted_time_[sig_idx] = last_transition_time_[sig_idx];
            }
        }
    }

}  // namespace vcd
