"""Build repository change relationship graphs."""

from __future__ import annotations

from collections import Counter

import networkx as nx

from src.git_loader.repo_loader import CommitRecord


class ChangeGraphBuilder:
    """Build graph relationships between developers, files, and modules."""

    def build(self, commits: list[CommitRecord]) -> nx.DiGraph:
        graph = nx.DiGraph()
        module_frequency: Counter[str] = Counter()

        for commit in commits:
            developer_node = f"developer:{commit.author}"
            graph.add_node(developer_node, kind="developer", label=commit.author)

            for file_path in commit.files_changed:
                file_node = f"file:{file_path}"
                module_name = self._module_for_file(file_path)
                module_node = f"module:{module_name}"

                graph.add_node(file_node, kind="file", label=file_path)
                graph.add_node(module_node, kind="module", label=module_name)

                edge_weight = graph.get_edge_data(developer_node, file_node, {}).get("weight", 0) + 1
                graph.add_edge(developer_node, file_node, relationship="edits", weight=edge_weight)
                graph.add_edge(file_node, module_node, relationship="belongs_to", weight=1)

                module_frequency[module_name] += 1

        for module_name, count in module_frequency.items():
            module_node = f"module:{module_name}"
            graph.nodes[module_node]["commit_frequency"] = count

        return graph

    @staticmethod
    def _module_for_file(file_path: str) -> str:
        parts = [part for part in file_path.split("/") if part]
        if len(parts) <= 1:
            return "root"
        return "/".join(parts[:2])
