# Clojure Pulse — project tasks. Run `make` (or `make help`) to list them.

.DEFAULT_GOAL := help

VERSION := $(shell node -p "require('./package.json').version")
VSIX := clojure-pulse-$(VERSION).vsix
EXTENSION_ID := abogoyavlensky.clojure-pulse

# The VS Code test host needs a display; use a virtual one on Linux, run
# directly elsewhere (e.g. macOS).
XVFB := $(shell command -v xvfb-run 2>/dev/null)
ifeq ($(XVFB),)
TEST_CMD := npm test
else
TEST_CMD := xvfb-run -a npm test
endif

.PHONY: help setup install compile watch lint test check package \
	install-extension uninstall-extension clean icon

help: ## List available tasks
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

setup: ## Install the toolchain (mise) and npm dependencies
	mise install
	npm install

install: ## Install npm dependencies
	npm install

compile: ## Type-check and bundle the extension
	npm run compile

watch: ## Rebuild the bundle on change
	npm run watch

lint: ## Run ESLint
	npm run lint

test: ## Run the test suite (uses xvfb on Linux)
	$(TEST_CMD)

check: lint compile test ## Lint, compile, and test

icon: ## Regenerate images/icon.png (256x256) from docs/images/icon.png
	node scripts/build-icon.mjs

package: ## Build the installable .vsix
	npm run package

install-extension: package ## Build the .vsix and install it into VS Code
	code --install-extension $(VSIX) --force

uninstall-extension: ## Remove the extension from VS Code
	code --uninstall-extension $(EXTENSION_ID)

clean: ## Remove build output and packaged artifacts
	rm -rf dist out .vscode-test *.vsix
