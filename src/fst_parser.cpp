#include "fst_parser.h"

#include <cstring>
#include <unordered_map>

#include "fstapi.h"
#include "lod_manager.h"

namespace vcd
{
    struct FstParser::Impl
    {
        fstReaderContext* ctx = nullptr;
        std::vector<SignalDef> signals;
        std::unique_ptr<ScopeNode> root_scope;
        std::unordered_map<std::string, uint32_t> sig_map;
        std::unordered_map<fstHandle, uint32_t> handle_to_sig;

        std::vector<uint8_t> current_state_1bit;
        std::vector<std::string> current_state_multi;

        std::vector<Transition1Bit> res_1bit;
        std::vector<TransitionMultiBit> res_multi;
        std::string string_pool;

        LodManager lod_manager;
        std::vector<int64_t> last_index_1bit;
        std::vector<int64_t> last_index_multi;

        uint64_t query_t_begin = 0;
        uint64_t query_t_end = 0;
        bool query_done = false;

        Timescale timescale_info;

        ~Impl()
        {
            if (ctx) fstReaderClose(ctx);
        }

        static void fst_callback(void* user_data, uint64_t time,
                                 fstHandle facidx, const unsigned char* value)
        {
            auto* self = static_cast<FstParser::Impl*>(user_data);
            self->handle_value(time, facidx, value, 0);
        }

        static void fst_callback_varlen(void* user_data, uint64_t time,
                                        fstHandle facidx,
                                        const unsigned char* value,
                                        uint32_t len)
        {
            auto* self = static_cast<FstParser::Impl*>(user_data);
            self->handle_value(time, facidx, value, len);
        }

        void handle_value(uint64_t time, fstHandle facidx,
                          const unsigned char* value, uint32_t len)
        {
            if (time < query_t_begin || time > query_t_end) return;

            auto it = handle_to_sig.find(facidx);
            if (it == handle_to_sig.end()) return;
            uint32_t sig_idx = it->second;
            const SignalDef& sig = signals[sig_idx];

            if (len == 0)
                len = static_cast<uint32_t>(
                    std::strlen(reinterpret_cast<const char*>(value)));

            if (sig.width == 1)
            {
                uint8_t v;
                uint8_t val_char = value[0];
                if (val_char == '0')
                    v = 0;
                else if (val_char == '1')
                    v = 1;
                else if (val_char == 'x' || val_char == 'X')
                    v = 2;
                else if (val_char == 'z' || val_char == 'Z')
                    v = 3;
                else
                    v = 0;

                uint8_t old_v = current_state_1bit[sig_idx];
                lod_manager.process_1bit(time, sig_idx, v, old_v, res_1bit,
                                         last_index_1bit);
                current_state_1bit[sig_idx] = v;
            }
            else
            {
                std::string val_tok;
                if (value[0] == 'b' || value[0] == 'B')
                {
                    val_tok = std::string(
                        reinterpret_cast<const char*>(value + 1), len - 1);
                }
                else
                {
                    val_tok =
                        std::string(reinterpret_cast<const char*>(value), len);
                }

                lod_manager.process_multibit(
                    time, sig_idx, val_tok, current_state_multi[sig_idx],
                    res_multi, last_index_multi, string_pool);
                current_state_multi[sig_idx] = val_tok;
            }
        }
    };

    FstParser::FstParser() : impl_(std::make_unique<Impl>()) {}
    FstParser::~FstParser() = default;

    FstParser::FstParser(FstParser&&) noexcept = default;
    FstParser& FstParser::operator=(FstParser&&) noexcept = default;

    bool FstParser::is_open() const { return impl_->ctx != nullptr; }

    bool FstParser::open_file(const std::string& filepath)
    {
        close_file();
        impl_->ctx = fstReaderOpen(filepath.c_str());
        if (impl_->ctx)
        {
            int ts = fstReaderGetTimescale(impl_->ctx);
            // Simple mapping for now, similar to what was in wasm_bindings.cpp
            if (ts >= -3)
            {
                impl_->timescale_info.unit = TimeUnit::MS;
                impl_->timescale_info.magnitude =
                    (ts == -3) ? 1 : ((ts == -2) ? 10 : 100);
            }
            else if (ts >= -6)
            {
                impl_->timescale_info.unit = TimeUnit::US;
                impl_->timescale_info.magnitude =
                    (ts == -6) ? 1 : ((ts == -5) ? 10 : 100);
            }
            else if (ts >= -9)
            {
                impl_->timescale_info.unit = TimeUnit::NS;
                impl_->timescale_info.magnitude =
                    (ts == -9) ? 1 : ((ts == -8) ? 10 : 100);
            }
            else if (ts >= -12)
            {
                impl_->timescale_info.unit = TimeUnit::PS;
                impl_->timescale_info.magnitude =
                    (ts == -12) ? 1 : ((ts == -11) ? 10 : 100);
            }
            else
            {
                impl_->timescale_info.unit = TimeUnit::FS;
                impl_->timescale_info.magnitude =
                    (ts == -15) ? 1 : ((ts == -14) ? 10 : 100);
            }
        }
        return impl_->ctx != nullptr;
    }

    void FstParser::close_file()
    {
        if (impl_->ctx)
        {
            fstReaderClose(impl_->ctx);
            impl_->ctx = nullptr;
        }
        impl_->signals.clear();
        impl_->root_scope.reset();
        impl_->sig_map.clear();
        impl_->handle_to_sig.clear();
    }

    void FstParser::begin_indexing() {}
    size_t FstParser::index_step(size_t chunk_size) { return 0; }

    void FstParser::finish_indexing()
    {
        if (!impl_->ctx) return;
        impl_->root_scope = std::make_unique<ScopeNode>();
        impl_->root_scope->name = "__root__";
        impl_->root_scope->full_path = "";

        std::vector<ScopeNode*> stack;
        stack.push_back(impl_->root_scope.get());

        struct fstHier* h;
        while ((h = fstReaderIterateHier(impl_->ctx)))
        {
            switch (h->htyp)
            {
                case FST_HT_SCOPE:
                {
                    auto scope = std::make_unique<ScopeNode>();
                    scope->name =
                        std::string(h->u.scope.name, h->u.scope.name_length);
                    scope->parent = stack.back();
                    scope->full_path =
                        scope->parent->full_path.empty()
                            ? scope->name
                            : scope->parent->full_path + "." + scope->name;
                    ScopeNode* raw_ptr = scope.get();
                    stack.back()->children.push_back(std::move(scope));
                    stack.push_back(raw_ptr);
                    break;
                }
                case FST_HT_UPSCOPE:
                {
                    if (stack.size() > 1) stack.pop_back();
                    break;
                }
                case FST_HT_VAR:
                {
                    if (h->u.var.is_alias) break;
                    SignalDef sig;
                    sig.name = std::string(h->u.var.name, h->u.var.name_length);
                    sig.full_path = stack.back()->full_path + "." + sig.name;
                    sig.width = h->u.var.length;
                    sig.id_code = std::to_string(h->u.var.handle);
                    sig.index = static_cast<uint32_t>(impl_->signals.size());

                    switch (h->u.var.typ)
                    {
                        case FST_VT_VCD_WIRE:
                            sig.type = VarType::Wire;
                            break;
                        case FST_VT_VCD_REG:
                            sig.type = VarType::Reg;
                            break;
                        case FST_VT_VCD_INTEGER:
                            sig.type = VarType::Integer;
                            break;
                        case FST_VT_VCD_PARAMETER:
                            sig.type = VarType::Parameter;
                            break;
                        case FST_VT_VCD_REAL:
                            sig.type = VarType::Real;
                            break;
                        default:
                            sig.type = VarType::Unknown;
                            break;
                    }

                    impl_->handle_to_sig[h->u.var.handle] = sig.index;
                    impl_->signals.push_back(std::move(sig));
                    stack.back()->signal_indices.push_back(sig.index);
                    impl_->sig_map[sig.full_path] = sig.index;
                    break;
                }
            }
        }
    }

    const Timescale& FstParser::timescale() const
    {
        return impl_->timescale_info;
    }
    uint64_t FstParser::time_begin() const
    {
        return impl_->ctx ? fstReaderGetStartTime(impl_->ctx) : 0;
    }
    uint64_t FstParser::time_end() const
    {
        return impl_->ctx ? fstReaderGetEndTime(impl_->ctx) : 0;
    }
    size_t FstParser::signal_count() const { return impl_->signals.size(); }
    const std::string& FstParser::date() const
    {
        static std::string d;
        d = impl_->ctx ? fstReaderGetDateString(impl_->ctx) : "";
        return d;
    }
    const std::string& FstParser::version() const
    {
        static std::string v;
        v = impl_->ctx ? fstReaderGetVersionString(impl_->ctx) : "";
        return v;
    }

    const std::vector<SignalDef>& FstParser::signals() const
    {
        return impl_->signals;
    }
    const ScopeNode* FstParser::root_scope() const
    {
        return impl_->root_scope.get();
    }
    const SignalDef* FstParser::find_signal(const std::string& full_path) const
    {
        auto it = impl_->sig_map.find(full_path);
        if (it != impl_->sig_map.end()) return &impl_->signals[it->second];
        return nullptr;
    }

    QueryPlan FstParser::get_query_plan(uint64_t start_time) const
    {
        QueryPlan plan;
        plan.file_offset = 0;
        plan.snapshot_time = start_time;
        plan.snapshot_index = 0;
        return plan;
    }

    void FstParser::begin_query(uint64_t start_time, uint64_t end_time,
                                const std::vector<uint32_t>& signal_indices,
                                size_t snapshot_index, float pixel_time_step)
    {
        if (!impl_->ctx) return;
        impl_->query_t_begin = start_time;
        impl_->query_t_end = end_time;

        fstReaderSetLimitTimeRange(impl_->ctx, start_time, end_time);
        fstReaderClrFacProcessMaskAll(impl_->ctx);

        size_t n_sigs = impl_->signals.size();
        impl_->lod_manager.reset(n_sigs, pixel_time_step);
        impl_->last_index_1bit.assign(n_sigs, -1);
        impl_->last_index_multi.assign(n_sigs, -1);
        impl_->current_state_1bit.assign(n_sigs, 2);  // default 'x'
        impl_->current_state_multi.assign(n_sigs, "x");

        impl_->res_1bit.clear();
        impl_->res_multi.clear();
        impl_->string_pool.clear();
        impl_->query_done = false;

        std::vector<char> val_buf(65536);
        for (uint32_t idx : signal_indices)
        {
            if (idx < impl_->signals.size())
            {
                fstHandle handle = std::stoull(impl_->signals[idx].id_code);
                fstReaderSetFacProcessMask(impl_->ctx, handle);
                uint32_t width = impl_->signals[idx].width;
                if (width + 1 > val_buf.size()) val_buf.resize(width + 1);
                char* v = fstReaderGetValueFromHandleAtTime(
                    impl_->ctx, start_time, handle, val_buf.data());
                if (v)
                {
                    std::string_view val_sv(v);
                    if (width == 1)
                    {
                        uint8_t val = (v[0] == '1') ? 1 : (v[0] == '0' ? 0 : 2);
                        impl_->lod_manager.emit_initial_1bit(
                            start_time, idx, val, impl_->res_1bit,
                            impl_->last_index_1bit);
                        impl_->current_state_1bit[idx] = val;
                    }
                    else
                    {
                        impl_->lod_manager.emit_initial_multibit(
                            start_time, idx, val_sv, impl_->res_multi,
                            impl_->last_index_multi, impl_->string_pool);
                        impl_->current_state_multi[idx] = std::string(val_sv);
                    }
                }
            }
        }
    }

    bool FstParser::query_step(size_t chunk_size)
    {
        if (!impl_->ctx || impl_->query_done) return false;
        fstReaderIterBlocks2(impl_->ctx, Impl::fst_callback,
                             Impl::fst_callback_varlen, impl_.get(), nullptr);
        impl_->query_done = true;
        return false;
    }

    QueryResultBinary FstParser::flush_query_binary()
    {
        // Flush any open glitches at the end of the query range
        impl_->lod_manager.flush_glitches(
            impl_->res_1bit, impl_->last_index_1bit, impl_->res_multi,
            impl_->last_index_multi, impl_->string_pool);

        QueryResultBinary res;
        res.transitions_1bit = impl_->res_1bit.data();
        res.count_1bit = impl_->res_1bit.size();
        res.transitions_multibit = impl_->res_multi.data();
        res.count_multibit = impl_->res_multi.size();
        res.string_pool = impl_->string_pool.data();
        res.string_pool_size = impl_->string_pool.size();
        return res;
    }

    void FstParser::cancel_query() { impl_->query_done = true; }
    size_t FstParser::snapshot_count() const { return 0; }
    size_t FstParser::index_memory_usage() const { return 0; }
}  // namespace vcd
