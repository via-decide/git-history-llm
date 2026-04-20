window.GraphTimeline = {
  filterByPercent(data, percent) {
    const commitNodes = data.nodes.filter((node) => node.type === "commit");
    const sortedCommits = commitNodes
      .slice()
      .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());

    const keepCount = Math.max(1, Math.ceil((sortedCommits.length * percent) / 100));
    const commitIds = new Set(sortedCommits.slice(0, keepCount).map((node) => node.id));

    const keptEdges = data.edges.filter((edge) => {
      if (!edge.source.startsWith("commit:")) return true;
      return commitIds.has(edge.source);
    });

    const connectedNodeIds = new Set();
    keptEdges.forEach((edge) => {
      connectedNodeIds.add(edge.source);
      connectedNodeIds.add(edge.target);
    });

    const keptNodes = data.nodes.filter((node) => connectedNodeIds.has(node.id) || node.type === "cluster");

    return { nodes: keptNodes, edges: keptEdges };
  },
};
