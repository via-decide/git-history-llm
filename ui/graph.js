(function () {
  const svg = d3.select("#graph");
  const tooltip = d3.select("body").append("div").attr("class", "tooltip").style("opacity", 0);
  const detailPanel = document.getElementById("detail-content");
  const timeline = document.getElementById("timeline-range");
  const timelineLabel = document.getElementById("timeline-label");

  const colors = {
    commit: "#3b82f6",
    file: "#22c55e",
    author: "#f59e0b",
    module: "#8b5cf6",
    cluster: "#64748b",
  };

  function updateDetails(node) {
    if (node.type === "commit") {
      detailPanel.innerHTML = `
        <strong>Commit</strong><br>
        Hash: ${node.hash || node.id.replace("commit:", "")}<br>
        Author: ${node.author || "Unknown"}<br>
        Message: ${node.message || ""}<br>
        Files changed: ${(node.files_changed || []).length}<br>
        Timestamp: ${node.timestamp || "n/a"}
      `;
      return;
    }

    detailPanel.innerHTML = `<pre>${JSON.stringify(node, null, 2)}</pre>`;
  }

  function render(data) {
    svg.selectAll("*").remove();

    const width = document.getElementById("graph").clientWidth;
    const height = document.getElementById("graph").clientHeight;

    svg.attr("viewBox", [0, 0, width, height]);
    const container = svg.append("g");

    svg.call(
      d3
        .zoom()
        .scaleExtent([0.2, 4])
        .on("zoom", (event) => container.attr("transform", event.transform))
    );

    const simulation = d3
      .forceSimulation(data.nodes)
      .force("link", d3.forceLink(data.edges).id((d) => d.id).distance(90))
      .force("charge", d3.forceManyBody().strength(-250))
      .force("center", d3.forceCenter(width / 2, height / 2));

    const link = container
      .append("g")
      .selectAll("line")
      .data(data.edges)
      .join("line")
      .attr("class", "edge")
      .attr("stroke-width", 1.2);

    const node = container
      .append("g")
      .selectAll("circle")
      .data(data.nodes)
      .join("circle")
      .attr("class", "node")
      .attr("r", (d) => (d.type === "commit" ? 7 : 9))
      .attr("fill", (d) => colors[d.type] || "#cbd5e1")
      .on("mouseover", function (event, d) {
        tooltip.style("opacity", 1).html(`<strong>${d.type}</strong><br>${d.id}`);
        d3.select(this).classed("highlight", true);
      })
      .on("mousemove", (event) => {
        tooltip.style("left", `${event.pageX + 10}px`).style("top", `${event.pageY + 10}px`);
      })
      .on("mouseout", function () {
        tooltip.style("opacity", 0);
        d3.select(this).classed("highlight", false);
      })
      .on("click", (_, d) => {
        updateDetails(d);
        const neighbors = new Set();
        data.edges.forEach((edge) => {
          const sourceId = typeof edge.source === "string" ? edge.source : edge.source.id;
          const targetId = typeof edge.target === "string" ? edge.target : edge.target.id;
          if (sourceId === d.id) neighbors.add(targetId);
          if (targetId === d.id) neighbors.add(sourceId);
        });

        node.attr("opacity", (n) => (n.id === d.id || neighbors.has(n.id) ? 1 : 0.2));
        link.attr("opacity", (e) => {
          const sourceId = typeof e.source === "string" ? e.source : e.source.id;
          const targetId = typeof e.target === "string" ? e.target : e.target.id;
          return sourceId === d.id || targetId === d.id ? 1 : 0.1;
        });
      })
      .call(
        d3
          .drag()
          .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      );

    simulation.on("tick", () => {
      link
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);

      node.attr("cx", (d) => d.x).attr("cy", (d) => d.y);
    });
  }

  async function init() {
    try {
      const baseData = await window.GraphDataLoader.load();
      render(baseData);

      timeline.addEventListener("input", () => {
        const value = Number(timeline.value);
        timelineLabel.textContent = `Showing ${value}% most recent commits`;
        render(window.GraphTimeline.filterByPercent(baseData, value));
      });
    } catch (error) {
      detailPanel.textContent = error.message;
    }
  }

  init();
})();
