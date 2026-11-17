# Benchmark Methodology

MOSAIC benchmarks are orchestrated by `python-analytics/src/mosaic_analytics/benchmark_runner.py` over loopback (`127.0.0.1` / `localhost`).

## Protocol

1. **Idle Baseline**: Sample available RAM via `psutil` before loading the model.
2. **Cold Load**: Unload any active instance (`keep_alive: 0`) and measure the first `load_duration`.
3. **Warm Trials**: Execute repeated fixed-prompt requests (`temperature: 0.0`, `num_predict: 64`) and summarize `median`, `min`, and `max`.
4. **Separated Metrics**: Report **Time-to-First-Token (TTFT)** (`prompt_eval_duration`) and **Generation Speed** (`eval_count / eval_duration`) independently—never combined into a single ambiguous figure.
5. **Local Export**: Export reports locally to JSON, CSV, or HTML-escaped tables with zero network upload.
