.PHONY: test check serve

test:
	python3 -m unittest discover -s tests -v

check: test
	node --check web/app.js

serve:
	python3 -m http.server 8000 -d web
