.PHONY: reproduce test-python test-ts benchmarks figures clean

reproduce: test-python test-ts benchmarks
	@echo "[SwarmSync] Full reproduction complete: all unit tests passed and CSV/JSON/SVG/PNG artifacts regenerated."

test-python:
	python3 -m unittest discover -s tests -v > experiments/results/unit_test.log 2>&1
	cat experiments/results/unit_test.log

test-ts:
	npx --yes tsx --test src/sim/engine.test.ts

benchmarks:
	python3 -m experiments.run_all > experiments/results/benchmark_run.log 2>&1
	cat experiments/results/benchmark_run.log

clean:
	rm -rf experiments/results/*.csv experiments/results/*.json experiments/figures/*.svg experiments/figures/*.png
