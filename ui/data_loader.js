window.GraphDataLoader = {
  async load(path = "../output/graph.json") {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`Unable to load graph data from ${path}`);
    }
    return response.json();
  },
};
