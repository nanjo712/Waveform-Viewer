#!/usr/bin/env python3
"""
Generate large-scale VCD files for stress-testing the parser.
Usage: python3 gen_large_vcd.py [output_path] [target_size_mb]
"""

import sys
import os
import random

def main():
    output_path = sys.argv[1] if len(sys.argv) > 1 else "tests/large_test.vcd"
    target_mb = int(sys.argv[2]) if len(sys.argv) > 2 else 100
    target_bytes = target_mb * 1024 * 1024

    # Parameters
    num_1bit_signals = 64
    num_multibit_signals = 32  # 8~64 bit wide
    time_step = 5  # simulation time increment per cycle
    signals_toggle_per_cycle = 30  # average number of signals changing per cycle

    random.seed(42)

    # Build signal definitions
    signals = []  # (id_code, name, width, scope_path)
    id_counter = 0

    def next_id():
        nonlocal id_counter
        # VCD id codes: printable ASCII 33-126, can be multi-char
        chars = []
        n = id_counter
        while True:
            chars.append(chr(33 + (n % 94)))
            n = n // 94
            if n == 0:
                break
        id_counter += 1
        return ''.join(chars)

    scopes = [
        ("top", [
            ("cpu", [
                ("alu", []),
                ("regfile", []),
                ("control", []),
            ]),
            ("mem", [
                ("cache", []),
                ("arbiter", []),
            ]),
            ("io", []),
        ]),
    ]

    # Distribute signals across scopes
    flat_scopes = []
    def flatten(name, children, path=""):
        full = f"{path}.{name}" if path else name
        flat_scopes.append(full)
        for child_name, grandchildren in children:
            flatten(child_name, grandchildren, full)
    for name, children in scopes:
        flatten(name, children)

    # Create 1-bit signals
    for i in range(num_1bit_signals):
        scope = flat_scopes[i % len(flat_scopes)]
        sig_name = f"sig1b_{i}"
        signals.append((next_id(), sig_name, 1, scope))

    # Create multi-bit signals
    widths = [8, 16, 32, 64]
    for i in range(num_multibit_signals):
        scope = flat_scopes[i % len(flat_scopes)]
        w = widths[i % len(widths)]
        sig_name = f"sig{w}b_{i}"
        signals.append((next_id(), sig_name, w, scope))

    total_signals = len(signals)

    print(f"Generating VCD: {output_path}")
    print(f"  Target size:     ~{target_mb} MB")
    print(f"  1-bit signals:   {num_1bit_signals}")
    print(f"  Multi-bit sigs:  {num_multibit_signals}")
    print(f"  Total signals:   {total_signals}")

    written = 0
    with open(output_path, 'w') as f:
        # ---- Header ----
        f.write("$date\n  Generated for stress test\n$end\n")
        f.write("$version\n  gen_large_vcd.py v1.0\n$end\n")
        f.write("$timescale 1ns $end\n")

        # Group signals by scope and write $scope/$var/$upscope
        scope_signals = {}
        for id_code, name, width, scope in signals:
            scope_signals.setdefault(scope, []).append((id_code, name, width))

        def write_scope_tree(name, children, path=""):
            full = f"{path}.{name}" if path else name
            f.write(f"$scope module {name} $end\n")
            # Write signals in this scope
            for id_code, sig_name, width in scope_signals.get(full, []):
                f.write(f"$var wire {width} {id_code} {sig_name} $end\n")
            # Recurse into children
            for child_name, grandchildren in children:
                write_scope_tree(child_name, grandchildren, full)
            f.write("$upscope $end\n")

        for name, children in scopes:
            write_scope_tree(name, children)

        f.write("$enddefinitions $end\n")

        # ---- Initial values ($dumpvars) ----
        f.write("$dumpvars\n")
        # Track current state for realistic toggling
        state_1bit = [0] * num_1bit_signals
        state_multibit = []
        for i in range(num_multibit_signals):
            w = widths[i % len(widths)]
            state_multibit.append(0)

        for i in range(num_1bit_signals):
            id_code = signals[i][0]
            f.write(f"0{id_code}\n")

        for i in range(num_multibit_signals):
            idx = num_1bit_signals + i
            id_code = signals[idx][0]
            w = signals[idx][2]
            f.write(f"b{'0' * w} {id_code}\n")

        f.write("$end\n")

        written = f.tell()

        # ---- Value changes ----
        sim_time = 0
        cycle = 0
        report_interval = 10 * 1024 * 1024  # report every 10MB
        next_report = report_interval

        while written < target_bytes:
            f.write(f"#{sim_time}\n")

            # Randomly toggle some 1-bit signals
            num_toggle_1b = random.randint(
                signals_toggle_per_cycle // 2, signals_toggle_per_cycle
            )
            toggled_1b = random.sample(
                range(num_1bit_signals), min(num_toggle_1b, num_1bit_signals)
            )
            for i in toggled_1b:
                # Toggle or set to random value (including x/z occasionally)
                r = random.random()
                if r < 0.02:
                    val = 'x'
                elif r < 0.04:
                    val = 'z'
                else:
                    state_1bit[i] ^= 1
                    val = str(state_1bit[i])
                f.write(f"{val}{signals[i][0]}\n")

            # Update some multi-bit signals
            num_toggle_mb = random.randint(2, min(8, num_multibit_signals))
            toggled_mb = random.sample(range(num_multibit_signals), num_toggle_mb)
            for i in toggled_mb:
                idx = num_1bit_signals + i
                w = signals[idx][2]
                # Generate a random binary value
                new_val = random.getrandbits(w)
                state_multibit[i] = new_val
                bin_str = format(new_val, f'0{w}b')
                f.write(f"b{bin_str} {signals[idx][0]}\n")

            sim_time += time_step
            cycle += 1
            written = f.tell()

            if written >= next_report:
                print(f"  Progress: {written / (1024*1024):.1f} MB, "
                      f"time={sim_time}, cycles={cycle}")
                next_report += report_interval

    final_size = os.path.getsize(output_path)
    print(f"\nDone!")
    print(f"  Final size:  {final_size / (1024*1024):.1f} MB")
    print(f"  Sim time:    [0, {sim_time}]")
    print(f"  Cycles:      {cycle}")

if __name__ == "__main__":
    main()
