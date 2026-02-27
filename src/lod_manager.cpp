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
                 last_emitted_time_[sig_idx] !=
                     std::numeric_limits<uint64_t>::max() &&
                 (current_time - last_emitted_time_[sig_idx]) <
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
            // Normal transition OR Closing a glitch
            last_index_1bit[sig_idx] = static_cast<int64_t>(res_1bit.size());
            res_1bit.push_back({current_time, sig_idx, v, {0, 0, 0}});
            last_emitted_time_[sig_idx] = current_time;
            signal_is_glitch_[sig_idx] = false;
        }
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
            }
        }
        else if (pixel_time_step_ > 0.0f &&
                 last_emitted_time_[sig_idx] !=
                     std::numeric_limits<uint64_t>::max() &&
                 (current_time - last_emitted_time_[sig_idx]) <
                     static_cast<uint64_t>(pixel_time_step_))
        {
            // Glitch detected for multi-bit
            if (val_tok != old_v && !signal_is_glitch_[sig_idx])
            {
                int64_t last_idx = last_index_multi[sig_idx];
                if (last_idx >= 0)
                {
                    uint32_t offset =
                        static_cast<uint32_t>(query_string_pool.size());
                    const std::string g_str = "GLITCH";
                    query_string_pool.append(g_str);
                    res_multibit[last_idx].string_offset = offset;
                    res_multibit[last_idx].string_length =
                        static_cast<uint32_t>(g_str.size());
                }
                signal_is_glitch_[sig_idx] = true;
            }
        }
        else if (val_tok != old_v || signal_is_glitch_[sig_idx])
        {
            // Normal multi-bit transition OR Closing a glitch
            uint32_t offset = static_cast<uint32_t>(query_string_pool.size());
            query_string_pool.append(val_tok);
            last_index_multi[sig_idx] =
                static_cast<int64_t>(res_multibit.size());
            res_multibit.push_back({current_time, sig_idx, offset,
                                    static_cast<uint32_t>(val_tok.size()), 0});
            last_emitted_time_[sig_idx] = current_time;
            signal_is_glitch_[sig_idx] = false;
        }
    }

    void LodManager::emit_initial_1bit(uint64_t start_time, uint32_t sig_idx,
                                       uint8_t v,
                                       std::vector<Transition1Bit>& res_1bit,
                                       std::vector<int64_t>& last_index_1bit)
    {
        last_index_1bit[sig_idx] = static_cast<int64_t>(res_1bit.size());
        res_1bit.push_back({start_time, sig_idx, v, {0, 0, 0}});
        last_emitted_time_[sig_idx] = start_time;
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
        signal_is_glitch_[sig_idx] = false;
    }

}  // namespace vcd
