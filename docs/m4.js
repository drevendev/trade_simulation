(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const body = document.getElementById("m4-preview-body");
  if (!body) return;

  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]
  ));
  const number = (value, digits = 2) => Number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const percent = value => `${(Number(value) * 100).toFixed(1)}%`;

  function state(title, detail) {
    body.innerHTML = `<div class="m4-state"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(detail)}</p></div>`;
  }

  function finiteNonNegative(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  function validate(preview) {
    if (preview === null || typeof preview !== "object") return "artifact is not an object";
    if (preview.milestone !== "M4" || preview.requirement !== "REQ-VISUALIZATION-009") return "artifact is not the M4 preview";
    if (preview.scenario === null || typeof preview.scenario !== "object") return "scenario metadata is missing";
    if (preview.region === null || typeof preview.region !== "object") return "region metadata is missing";
    for (const key of ["name", "currencyCode", "goodsUnitLabel", "workerUnitLabel", "capitalUnitLabel"]) {
      if (typeof preview.region[key] !== "string" || preview.region[key].length === 0) return `region.${key} is missing`;
    }
    if (!Array.isArray(preview.samples)) return "sample series is missing";
    if (preview.totals === null || typeof preview.totals !== "object") return "whole-run totals are missing";
    for (const key of ["outputProduced", "grossWagesPaid", "capitalBuilt", "householdPurchaseQuantity"]) {
      if (!finiteNonNegative(preview.totals[key])) return `totals.${key} is not a finite non-negative number`;
    }
    for (const [index, sample] of preview.samples.entries()) {
      if (sample === null || typeof sample !== "object") return `sample ${index} is not an object`;
      for (const key of ["tick", "outputProduced", "employedWorkers", "grossWagesPaid", "essentialCoverage", "foodInventory", "installedCapital"]) {
        if (!finiteNonNegative(sample[key])) return `sample ${index}.${key} is not a finite non-negative number`;
      }
      if (sample.essentialCoverage > 1) return `sample ${index}.essentialCoverage exceeds 100%`;
    }
    return null;
  }

  function svgElement(tag, attributes, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (parent) parent.appendChild(node);
    return node;
  }

  function chart(title, unit, samples, key, formatter = value => number(value)) {
    const wrap = document.createElement("div");
    wrap.className = "m4-small-multiple";
    wrap.innerHTML = `<div class="m4-chart-title">${escapeHtml(title)}</div><div class="m4-chart-unit">${escapeHtml(unit)}</div>`;

    const width = 320, height = 160;
    const pad = { top: 10, right: 10, bottom: 24, left: 48 };
    const values = samples.map(sample => Number(sample[key]));
    const ticks = samples.map(sample => Number(sample.tick));
    let minimum = Math.min(0, ...values);
    let maximum = Math.max(0, ...values);
    if (minimum === maximum) maximum = minimum + 1;
    const span = maximum - minimum;
    const x = index => ticks.length === 1
      ? pad.left + (width - pad.left - pad.right) / 2
      : pad.left + (index / (ticks.length - 1)) * (width - pad.left - pad.right);
    const y = value => height - pad.bottom - ((value - minimum) / span) * (height - pad.top - pad.bottom);

    const svg = svgElement("svg", {
      class: "m4-chart",
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": `${title}, ${unit}, sampled from tick ${ticks[0]} through tick ${ticks[ticks.length - 1]}. Exact values are in the table below.`,
    });
    wrap.appendChild(svg);

    for (let step = 0; step <= 3; step++) {
      const value = minimum + span * step / 3;
      const yy = y(value);
      svgElement("line", { class: "grid", x1: pad.left, x2: width - pad.right, y1: yy, y2: yy }, svg);
      const label = svgElement("text", { class: "label", x: pad.left - 5, y: yy + 3, "text-anchor": "end" }, svg);
      label.textContent = formatter(value);
    }
    svgElement("line", { class: "axis", x1: pad.left, x2: width - pad.right, y1: height - pad.bottom, y2: height - pad.bottom }, svg);
    const first = svgElement("text", { class: "label", x: pad.left, y: height - 7, "text-anchor": "start" }, svg);
    first.textContent = String(ticks[0]);
    const last = svgElement("text", { class: "label", x: width - pad.right, y: height - 7, "text-anchor": "end" }, svg);
    last.textContent = String(ticks[ticks.length - 1]);

    if (samples.length === 1) {
      svgElement("circle", { class: "dot", cx: x(0), cy: y(values[0]), r: 3 }, svg);
    } else {
      svgElement("polyline", {
        class: "trace",
        points: values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" "),
      }, svg);
    }
    return wrap;
  }

  function visualGroup(title, note, charts) {
    const group = document.createElement("section");
    group.className = "m4-visual-group";
    group.innerHTML = `<h3>${escapeHtml(title)}</h3><p class="m4-note">${escapeHtml(note)}</p>`;
    for (const item of charts) group.appendChild(item);
    return group;
  }

  function render(preview) {
    if (preview.samples.length === 0) {
      state("M4 preview empty", "The artifact is valid, but the deterministic run contains no sampled ticks. No values are invented in its place.");
      return;
    }

    const money = preview.region.currencyCode;
    const goods = preview.region.goodsUnitLabel;
    const workers = preview.region.workerUnitLabel;
    const capital = preview.region.capitalUnitLabel;

    body.innerHTML = `
      <dl class="m4-metrics" aria-label="M4 whole-run summary">
        <div class="m4-metric"><dt>Run length</dt><dd>${escapeHtml(preview.scenario.ticksExecuted)}<small>ticks</small></dd></div>
        <div class="m4-metric"><dt>Output produced</dt><dd>${escapeHtml(number(preview.totals.outputProduced))}<small>${escapeHtml(goods)}, cumulative</small></dd></div>
        <div class="m4-metric"><dt>Gross wages paid</dt><dd>${escapeHtml(number(preview.totals.grossWagesPaid))}<small>${escapeHtml(money)}, cumulative</small></dd></div>
        <div class="m4-metric"><dt>Household purchases</dt><dd>${escapeHtml(number(preview.totals.householdPurchaseQuantity))}<small>${escapeHtml(goods)}, cumulative</small></dd></div>
        <div class="m4-metric"><dt>Capital built</dt><dd>${escapeHtml(number(preview.totals.capitalBuilt))}<small>${escapeHtml(capital)}, cumulative</small></dd></div>
      </dl>
      <div class="m4-groups" id="m4-groups" style="min-width:0;max-width:100%"></div>
      <div class="m4-table-scroll" id="m4-table" style="max-width:100%;overflow-x:auto"></div>`;

    const groups = document.getElementById("m4-groups");
    groups.appendChild(visualGroup(
      "Production",
      "Realized Phase-5 output. It is physical flow for each sampled tick, not planned capacity.",
      [chart("Realized output", `${goods} per tick`, preview.samples, "outputProduced")],
    ));
    groups.appendChild(visualGroup(
      "Work and needs",
      "Employment and essential-need coverage are separate small multiples because worker-equivalents and percentages are unlike units.",
      [
        chart("Employment", `${workers} per tick`, preview.samples, "employedWorkers"),
        chart("Essential-need coverage", "% of target after Phase 9", preview.samples, "essentialCoverage", value => `${Math.max(0, value * 100).toFixed(0)}%`),
      ],
    ));
    groups.appendChild(visualGroup(
      "Stocks and capital",
      "Food inventory and installed capital are persistent stocks, kept on separate axes because their physical units differ.",
      [
        chart(`${preview.region.foodGoodName} inventory`, goods, preview.samples, "foodInventory"),
        chart("Installed capital", capital, preview.samples, "installedCapital"),
      ],
    ));

    const rows = preview.samples.map(sample => `<tr>
      <th scope="row">${escapeHtml(sample.tick)}</th>
      <td>${escapeHtml(number(sample.outputProduced, 4))}</td>
      <td>${escapeHtml(number(sample.employedWorkers, 3))}</td>
      <td>${escapeHtml(number(sample.grossWagesPaid, 2))}</td>
      <td>${escapeHtml(percent(sample.essentialCoverage))}</td>
      <td>${escapeHtml(number(sample.foodInventory, 2))}</td>
      <td>${escapeHtml(number(sample.installedCapital, 2))}</td>
    </tr>`).join("");
    document.getElementById("m4-table").innerHTML = `
      <table>
        <caption>Exact sampled values for ${escapeHtml(preview.region.name)}. Flow values are per sampled tick; inventory and capital are closing stocks.</caption>
        <thead><tr>
          <th scope="col">Tick</th>
          <th scope="col">Output (${escapeHtml(goods)}/tick)</th>
          <th scope="col">Employment (${escapeHtml(workers)})</th>
          <th scope="col">Gross wages (${escapeHtml(money)}/tick)</th>
          <th scope="col">Essential coverage</th>
          <th scope="col">Food stock (${escapeHtml(goods)})</th>
          <th scope="col">Installed capital (${escapeHtml(capital)})</th>
        </tr></thead><tbody>${rows}</tbody>
      </table>`;
  }

  const requested = new URLSearchParams(location.search).get("m4");
  const artifact = requested && /^[a-z0-9-]+\.json$/.test(requested) ? requested : "m4-preview.json";
  fetch(artifact)
    .then(response => {
      if (!response.ok) {
        const error = new Error(`${artifact}: HTTP ${response.status}`);
        error.unavailable = true;
        throw error;
      }
      return response.text();
    })
    .then(text => {
      let preview;
      try { preview = JSON.parse(text); }
      catch (error) { throw new Error(`artifact is not valid JSON (${error.message})`); }
      const problem = validate(preview);
      if (problem !== null) throw new Error(problem);
      render(preview);
    })
    .catch(error => {
      if (error.unavailable === true) {
        state("M4 preview unavailable", `The deterministic preview artifact could not be fetched — ${error.message}. Nothing stale is substituted.`);
      } else {
        state("M4 preview error", `The artifact was fetched but could not be used: ${error.message}.`);
      }
    });
})();
