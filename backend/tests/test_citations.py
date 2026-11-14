import unittest

from tests import _helpers  # noqa: F401
from app.services.citations import extract_sources, link_citations, renumber_sources, strip_table_links


def search_output(*pages):
    return "\n\n".join(
        f"--- SOURCE {i}: {title} ---\nURL: {url}\n\nbody" for i, (title, url) in enumerate(pages, 1)
    )


class CitationTests(unittest.TestCase):
    def test_renumber_sources_across_searches(self):
        first = search_output(("A1", "https://a.com/1"), ("A2", "https://a.com/2"))
        second = search_output(("B1", "https://b.com/1"))
        out = renumber_sources([first, second])
        sources = {}
        for text in out:
            sources.update(extract_sources(text))
        self.assertEqual(sources[3]["url"], "https://b.com/1")
        self.assertEqual(sources[1]["url"], "https://a.com/1")

    def test_markers_become_links(self):
        sources = extract_sources(search_output(("Page A", "https://a.com/x")))
        self.assertEqual(
            link_citations("Answer 【1†source】", sources),
            'Answer [a.com](https://a.com/x "Page A")',
        )

    def test_unresolved_marker_is_dropped(self):
        self.assertEqual(link_citations("Answer 【9†source】.", {}), "Answer .")

    def test_only_web_links(self):
        sources = extract_sources(search_output(("Bad", "javascript:alert(1)")))
        self.assertEqual(sources, {})
        self.assertNotIn("javascript", link_citations("x 【1†source】", sources))

    def test_code_blocks_keep_urls(self):
        text = "```bash\n| a | b |\n|---|---|\n| curl https://api.x.com/v1 | x |\n```"
        self.assertEqual(strip_table_links(text), text)

    def test_table_links_are_removed(self):
        self.assertNotIn("https://", strip_table_links("| a | b |\n|---|---|\n| x | [l](https://a.com) |"))


if __name__ == "__main__":
    unittest.main()
