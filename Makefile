# One task interface for every app, whatever the language (ADR 0010).
#   make <task> APP=<app>      task: dev build test lint typecheck format
#   APP is a name under apps/ or packages/ (e.g. api, voice-worker, py-common) or a path.
# Node apps run their package.json script; Python apps run through uv. A Python app can
# override any task by shipping its own Makefile (e.g. `dev`, which is app-specific).

TASKS := dev build test lint typecheck format
.PHONY: $(TASKS) help

APP_DIR := $(firstword $(wildcard $(APP) apps/$(APP) packages/$(APP)))

help:
	@echo "usage: make <$(subst $() ,|,$(TASKS))> APP=<app>"

$(TASKS):
ifndef APP
	$(error APP is required, e.g. make $@ APP=api)
endif
ifeq ($(APP_DIR),)
	$(error no app '$(APP)' under apps/ or packages/)
endif
	@if [ -f "$(APP_DIR)/package.json" ]; then \
	  pnpm --dir "$(APP_DIR)" run $@; \
	elif [ -f "$(APP_DIR)/Makefile" ] && $(MAKE) -C "$(APP_DIR)" -n $@ >/dev/null 2>&1; then \
	  $(MAKE) -C "$(APP_DIR)" $@; \
	elif [ -f "$(APP_DIR)/pyproject.toml" ]; then \
	  $(MAKE) --no-print-directory py-$@ DIR="$(APP_DIR)"; \
	else \
	  echo "$(APP_DIR): no package.json or pyproject.toml" >&2; exit 1; \
	fi

# ---- Python defaults (run inside the app dir) ----
UV := uv --directory $(DIR)

.PHONY: py-dev py-build py-test py-lint py-typecheck py-format
py-dev:
	@echo "$(DIR): define a 'dev' target in $(DIR)/Makefile" >&2; exit 1
py-build:
	$(UV) lock --check && $(UV) sync --locked && $(UV) run python -m compileall -q .
py-test:
	@$(UV) run pytest; code=$$?; \
	if [ $$code -eq 5 ]; then echo "$(DIR): no tests collected yet"; exit 0; fi; exit $$code
py-lint:
	$(UV) run ruff check . && $(UV) run ruff format --check .
py-typecheck:
	$(UV) run mypy .
py-format:
	$(UV) run ruff format . && $(UV) run ruff check --fix .
