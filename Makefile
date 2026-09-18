# Clojure Pulse — project tasks. Run `make` (or `make help`) to list them.

.DEFAULT_GOAL := help

VERSION := $(shell node -p "require('./package.json').version")
EXTENSION_ID := abogoyavlensky.clojure-pulse

# The vsce target for this machine, so `make package` bundles the matching
# clj-pulse. Windows is not a supported dev host for this Makefile.
UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)
ifeq ($(UNAME_S),Darwin)
HOST_OS := darwin
else
HOST_OS := linux
endif
ifneq (,$(filter arm64 aarch64,$(UNAME_M)))
HOST_ARCH := arm64
else
HOST_ARCH := x64
endif
HOST_TARGET := $(HOST_OS)-$(HOST_ARCH)
VSIX := clojure-pulse-$(HOST_TARGET)-$(VERSION).vsix

# The VS Code test host needs a display; use a virtual one on Linux, run
# directly elsewhere (e.g. macOS).
XVFB := $(shell command -v xvfb-run 2>/dev/null)
ifeq ($(XVFB),)
TEST_CMD := npm test
else
TEST_CMD := xvfb-run -a npm test
endif

.PHONY: help setup install compile watch lint test check fetch-server package \
	package-universal install-extension uninstall-extension clean icon tag \
	clojuredocs

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

clojuredocs: ## Regenerate data/clojuredocs.json from the ClojureDocs export
	npm run clojuredocs:update

fetch-server: ## Download the pinned clj-pulse for this machine into server/
	scripts/fetch-server.sh $(HOST_TARGET)

package: fetch-server ## Build the .vsix for this machine, with clj-pulse bundled
	npx vsce package --target $(HOST_TARGET)

package-universal: ## Build the .vsix without a bundled server (uses clj-pulse from PATH)
	rm -rf server
	npm run package

tag: ## Tag the current commit with package.json's version and push the tag
	git tag v$(VERSION)
	git push origin v$(VERSION)

install-extension: package ## Build the .vsix and install it into VS Code
	code --install-extension $(VSIX) --force

uninstall-extension: ## Remove the extension from VS Code
	code --uninstall-extension $(EXTENSION_ID)

clean: ## Remove build output, packaged artifacts and the fetched server
	rm -rf dist out .vscode-test *.vsix server
