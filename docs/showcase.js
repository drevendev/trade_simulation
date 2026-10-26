(() => {
  "use strict";
  // Read-only rendering of already validated, checked-in milestone observations.
  const byId = id => document.getElementById(id);
  const select = byId("showcase-milestone");
  const slider = byId("spotlight-tick");
  const readout = byId("spotlight-readout");
  const metrics = byId("spotlight-metrics");
  const summary = byId("m4-run-summary");
  const heading = byId("showcase-player-title");
  const tag = byId("showcase-mode-tag");
  const description = byId("showcase-run-description");
  const source = byId("showcase-source");
  if (![select, slider, readout, metrics, summary, heading, tag, description, source].every(Boolean)) return;
  const runs = { m4: { status: "loading" }, m3: { status: "loading" } };
  const num = v => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = v => (v * 100).toFixed(1) + "%";
  const nonnegative = v => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const label = v => typeof v === "string" && v.trim().length > 0;

  // M3's detail viewer has a separate schema guard. A showcase projection must
  // also check the exact numbers and labels it will display, including units.
  function validateM3(p) {
    if (!p || p.milestone !== "M3" || p.requirement !== "REQ-VISUALIZATION-006") return "not an M3 artifact";
    if (!p.scenario || !Number.isSafeInteger(p.scenario.ticksExecuted) || p.scenario.ticksExecuted < 0 ||
        !label(p.scenario.scenarioId)) return "invalid M3 scenario";
    if (!p.market || !["regionName", "goodName", "quantityUnitLabel", "currencyCode"].every(k => label(p.market[k])))
      return "missing M3 market units";
    if (!Array.isArray(p.ticks)) return "missing M3 observations";
    let previous = 0;
    for (const tick of p.ticks) {
      if (!tick || !Number.isSafeInteger(tick.tick) || tick.tick <= previous ||
          tick.tick > p.scenario.ticksExecuted) return "invalid or unordered M3 tick";
      if (!["sellerNetPrice", "householdGrossPrice", "clearedQuantity", "unmetDemandQuantity",
            "buyerGrossCost", "consumptionTaxCollected"].every(k => nonnegative(tick[k]))) return "invalid M3 metric";
      previous = tick.tick;
    }
    if (p.ticks.length) {
      if (!p.totals || !nonnegative(p.totals.clearedQuantity) ||
          !nonnegative(p.totals.buyerGrossCost) || !nonnegative(p.totals.consumptionTaxCollected)) return "invalid M3 totals";
      // An observed per-tick realized flow (goods, buyer payments or tax) cannot exceed its whole-run sum.
      // Sparse tick histories need not sum to the totals, but an impossible
      // individual quantity or payment must not be presented as verified.
      if (p.ticks.some(tick => tick.clearedQuantity > p.totals.clearedQuantity ||
          tick.buyerGrossCost > p.totals.buyerGrossCost ||
          tick.consumptionTaxCollected > p.totals.consumptionTaxCollected)) {
        return "M3 observation exceeds whole-run total";
      }
    }
    return null;
  }

  function card(field, title, value, unit) {
    const node = document.createElement("div");
    node.dataset.spotlight = field;
    const dt = document.createElement("dt");
    dt.textContent = title;
    const dd = document.createElement("dd");
    dd.append(document.createTextNode(value));
    const small = document.createElement("small");
    small.textContent = unit;
    dd.appendChild(small);
    node.append(dt, dd);
    return node;
  }

  function unavailable(message) {
    slider.disabled = true;
    slider.value = "0";
    slider.max = "0";
    readout.textContent = message;
    metrics.textContent = "No verified sampled values are available.";
  }

  function renderTick() {
    const mode = select.value;
    const run = runs[mode];
    if (!run || run.status !== "ready") return;
    const samples = mode === "m4" ? run.data.samples : run.data.ticks;
    const i = Number(slider.value);
    if (!Number.isSafeInteger(i) || i < 0 || i >= samples.length) return unavailable("Selected sample unavailable");
    const tick = samples[i];
    readout.textContent = "tick " + tick.tick + " · sample " + (i + 1) + " of " + samples.length;
    let cards;
    if (mode === "m4") {
      const u = run.data.region;
      cards = [
        ["outputProduced", "Realized output", num(tick.outputProduced), u.goodsUnitLabel + " / tick"],
        ["employedWorkers", "Employment", num(tick.employedWorkers), u.workerUnitLabel],
        ["essentialCoverage", "Essential-need coverage", pct(tick.essentialCoverage), "of target"],
        ["grossWagesPaid", "Gross wages paid", num(tick.grossWagesPaid), u.currencyCode + " / tick"],
        ["installedCapital", "Installed capital", num(tick.installedCapital), u.capitalUnitLabel],
      ];
    } else {
      const u = run.data.market;
      cards = [
        ["sellerNetPrice", "Seller-net price", num(tick.sellerNetPrice), u.currencyCode + " / " + u.quantityUnitLabel],
        ["householdGrossPrice", "Buyer-gross price", num(tick.householdGrossPrice), u.currencyCode + " / " + u.quantityUnitLabel],
        ["clearedQuantity", "Quantity cleared", num(tick.clearedQuantity), u.quantityUnitLabel + " / tick"],
        ["unmetDemandQuantity", "Unmet demand", num(tick.unmetDemandQuantity), u.quantityUnitLabel + " / tick"],
        ["buyerGrossCost", "Buyers paid", num(tick.buyerGrossCost), u.currencyCode + " / tick"],
        ["consumptionTaxCollected", "Consumption tax collected", num(tick.consumptionTaxCollected), u.currencyCode + " / tick"],
      ];
    }
    metrics.replaceChildren(...cards.map(args => card(...args)));
  }

  function render() {
    const mode = select.value;
    const run = runs[mode];
    if (!run) return;
    const m4 = mode === "m4";
    tag.textContent = m4 ? "M4 SAVED RUN" : "M3 MARKET RUN";
    heading.textContent = m4 ? "An economy at a glance" : "Inside a local market";
    description.textContent = m4
      ? "Scrub actual sampled ticks from a validated closed-economy run. These values measure what happened, not why."
      : "Scrub real market ticks. Prices, physical quantities and cash transfers have separate units.";
    const selectedFiles = new URLSearchParams(location.search).getAll("m4");
    const sourceFile = m4 && selectedFiles.length === 1 ? selectedFiles[0] : "m4-preview.json";
    source.textContent = m4
      ? "Selected validated " + sourceFile + " artifact. Detailed charts and exact values live in the M4 chapter."
      : "Validated m3-preview.json artifact. Detailed charts and settlement receipts live in the M3 chapter.";
    if (run.status !== "ready") {
      summary.textContent = run.status === "loading" ? "Loading verified " + mode.toUpperCase() + " observations…" :
        "No validated " + mode.toUpperCase() + " observations were loaded.";
      return unavailable(run.status === "loading" ? "Loading samples…" : run.error);
    }
    const data = run.data;
    const samples = m4 ? data.samples : data.ticks;
    if (m4) {
      summary.textContent = "Selected scenario: " + (label(data.scenario.scenarioId) ? data.scenario.scenarioId : "unnamed scenario") +
        ". Run length: " + data.scenario.ticksExecuted + " ticks. " +
        (samples.length ? "Samples span ticks " + samples[0].tick + "–" + samples[samples.length - 1].tick +
          "; last sampled output: " + samples[samples.length - 1].outputProduced + " " + data.region.goodsUnitLabel + "/tick." :
          "No sampled ticks or observed output values.");
    } else {
      summary.textContent = "Selected market: " + data.market.goodName + " in " + data.market.regionName +
        ". Scenario: " + data.scenario.scenarioId + ". Run length: " + data.scenario.ticksExecuted + " ticks. " +
        (samples.length ? "Cumulative clearing: " + num(data.totals.clearedQuantity) + " " + data.market.quantityUnitLabel +
          "; buyers paid " + num(data.totals.buyerGrossCost) + " " + data.market.currencyCode + "." : "No market observations recorded.");
    }
    if (!samples.length) return unavailable("This run has no observed ticks");
    slider.disabled = false;
    slider.min = "0";
    slider.max = String(samples.length - 1);
    slider.step = "1";
    slider.value = slider.max;
    renderTick();
  }

  select.addEventListener("change", render);
  slider.addEventListener("input", renderTick);
  window.showcaseSavedRun = {
    ready(mode, data) {
      if (!Object.prototype.hasOwnProperty.call(runs, mode)) return;
      const problem = mode === "m3" ? validateM3(data) : (!data || !Array.isArray(data.samples) ? "invalid M4 observations" : null);
      runs[mode] = problem ? { status: "error", error: "Saved run could not be displayed: " + problem } : { status: "ready", data };
      if (select.value === mode) render();
    },
    failure(mode, message) {
      if (!Object.prototype.hasOwnProperty.call(runs, mode)) return;
      runs[mode] = { status: "error", error: String(message) };
      if (select.value === mode) render();
    },
  };
  render();
})();
