#!/usr/bin/env python3
"""Check the current GitHub Pages experience without network calls or dependencies.

The preserved /short/ film and its studio are excluded from page quality checks;
links into them must still resolve. Browser QA remains necessary for readability,
layout, interactions, and the 60-second film.
"""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "githubpages"
issues = []
references = 0

class Page(HTMLParser):
    def __init__(self, path):
        super().__init__(convert_charrefs=True)
        self.path = path
        self.ids = set()
        self.links = []
        self.lang = None
        self.title = False
        self.description = False
        self.canonical = None
        self.feed(path.read_text(encoding="utf-8-sig"))

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        marker = attrs.get("id") or (attrs.get("name") if tag == "a" else None)
        if marker:
            if marker in self.ids:
                issues.append(f"{self.path.relative_to(ROOT)}: duplicate anchor #{marker}")
            self.ids.add(marker)
        if tag == "html":
            self.lang = attrs.get("lang")
        if tag == "title":
            self.title = True
        if tag == "meta" and attrs.get("name") == "description":
            self.description = bool(attrs.get("content", "").strip())
        if tag == "link" and attrs.get("rel") == "canonical":
            self.canonical = attrs.get("href")
        if tag == "img" and "alt" not in attrs:
            issues.append(f"{self.path.relative_to(ROOT)}:{self.getpos()[0]}: image lacks alt")
        for attr in ("href", "src", "poster"):
            if attrs.get(attr) and tag != "base":
                self.links.append((attrs[attr], self.getpos()[0], attr == "href"))
        if attrs.get("srcset"):
            for candidate in attrs["srcset"].split(","):
                if candidate.strip():
                    self.links.append((candidate.strip().split()[0], self.getpos()[0], False))

pages = {}
def page(path):
    if path not in pages:
        pages[path] = Page(path)
    return pages[path]

def check_reference(origin, href, line=0, check_fragment=False):
    global references
    address = urlsplit(href)
    if address.scheme or address.netloc:
        return
    references += 1
    decoded = unquote(address.path)
    target = ((SITE / decoded.lstrip("/")) if decoded.startswith("/")
              else origin.parent / decoded) if decoded else origin
    target = target.resolve()
    label = f"{origin.relative_to(ROOT)}:{line}"
    if not target.is_relative_to(SITE.resolve()):
        issues.append(f"{label}: link leaves published site: {href}")
        return
    if target.is_dir():
        target = target / "index.html"
    if not target.is_file():
        issues.append(f"{label}: missing local target: {href}")
        return
    if check_fragment and address.fragment and target.suffix == ".html":
        fragment = unquote(address.fragment)
        if fragment not in page(target).ids:
            issues.append(f"{label}: missing anchor: {href}")

current = [
    p for p in SITE.rglob("*.html")
    if "short" not in p.relative_to(SITE).parts and p.name != "short.html"
]
for path in current:
    doc = page(path)
    label = str(path.relative_to(ROOT))
    if not doc.lang:
        issues.append(f"{label}: missing document language")
    if not doc.title or not doc.description:
        issues.append(f"{label}: missing title or description")
    if not doc.canonical:
        issues.append(f"{label}: missing canonical URL")
    for href, line, fragment in doc.links:
        check_reference(path, href, line, fragment)

for path in SITE.rglob("*.css"):
    if "short" in path.relative_to(SITE).parts:
        continue
    css = path.read_text(encoding="utf-8-sig")
    for match in re.finditer(r"url\(\s*[\"']?([^\"')]+)[\"']?\s*\)", css):
        check_reference(path, match.group(1).strip())

# These images are loaded by the film player rather than HTML img elements.
capture_map = SITE / "film" / "captures.js"
if capture_map.is_file():
    for match in re.finditer(r"\b(?:src|mobileSrc)\s*:\s*['\"]([^'\"]+)['\"]", capture_map.read_text(encoding="utf-8-sig")):
        check_reference(capture_map, match.group(1))

version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
readme = (ROOT / "README.md").read_text(encoding="utf-8-sig")
home = (SITE / "index.html").read_text(encoding="utf-8-sig")
if f"badge/version-{version}-green" not in readme:
    issues.append("README.md: release version badge contract is missing or stale")
if f'<span id="app-version">v{version}</span>' not in home:
    issues.append("githubpages/index.html: release version span contract is missing or stale")

print(json.dumps({
    "pages": len(current), "localReferences": references,
    "scope": "Current pages, local anchors/assets, CSS URLs, film capture assets and release-version contracts. No remote-link or visual claims.",
    "errors": issues,
}, indent=2))
sys.exit(1 if issues else 0)
