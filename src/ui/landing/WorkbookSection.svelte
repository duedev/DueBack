<section id="workbook" class="wrap workbook">
  <p class="section-label">The deliverable</p>
  <h2>A workbook your office will actually accept.</h2>
  <p class="lede">
    Not a data dump: a themed, multi-sheet Excel file with live formulas, the
    receipt images embedded beside their rows, and an insights dashboard.
    Anything that doesn't fit a category lands on its own Miscellaneous sheet,
    never lost.
  </p>

  <!-- Sheet-tab order mirrors the real workbook: Fuel and Materials lead,
       Miscellaneous closes (util taxonomy; "Misc" is the tab shorthand). -->
  <div class="card book" aria-hidden="true">
    <div class="tabs">
      <span class="tab active">Summary</span>
      <span class="tab">Insights</span>
      <span class="tab">Fuel</span>
      <span class="tab">Materials</span>
      <span class="tab">Meals</span>
      <span class="tab">Misc</span>
    </div>
    <div class="body">
      <div class="table">
        <div class="thead">
          <span>Vendor</span><span>Date</span><span>Category</span><span class="num">Amount</span><span class="notes">Notes</span>
        </div>
        <div class="trow">
          <span>Maple St. Hardware</span><span>06/24</span>
          <span class="cat"><i class="dot" style="background: var(--cat-3)"></i>Materials</span>
          <span class="num">27.45</span><span class="notes"></span>
        </div>
        <div class="trow">
          <span>Corner Bistro</span><span>06/24</span>
          <span class="cat"><i class="dot" style="background: var(--cat-2)"></i>Meals</span>
          <span class="num">18.20</span><span class="notes note">billable</span>
        </div>
        <div class="trow">
          <span>CityGas #214</span><span>06/25</span>
          <span class="cat"><i class="dot" style="background: var(--cat-1)"></i>Fuel</span>
          <span class="num">41.03</span><span class="notes"></span>
        </div>
        <div class="trow">
          <span>Parking meter</span><span>06/26</span>
          <span class="cat"><i class="dot" style="background: var(--cat-4)"></i>Misc</span>
          <span class="num">4.00</span><span class="notes"></span>
        </div>
        <div class="tfoot">
          <span>TOTAL</span><span class="sum">$90.68</span>
        </div>
      </div>

      <div class="rail">
        <div class="chart">
          <div class="bar" style="height: 52%; background: var(--cat-1)"></div>
          <div class="bar" style="height: 30%; background: var(--cat-2)"></div>
          <div class="bar" style="height: 78%; background: var(--cat-3)"></div>
          <div class="bar" style="height: 22%; background: var(--cat-4)"></div>
        </div>
        <p class="rail-note">
          Insights sheet: spend by category and by week, largest vendors, and
          a log of anything flagged.
        </p>
        <div class="chips">
          <span class="chip">receipt images embedded</span>
          <span class="chip">custom notes per line (billable, needs-attention)</span>
          <span class="chip">+ CSV</span>
          <span class="chip">+ images ZIP</span>
        </div>
      </div>
    </div>
  </div>
</section>

<style>
  .lede {
    color: var(--ink-soft);
    max-width: 44rem;
    margin-top: -0.6rem;
  }

  .book {
    overflow: hidden;
    margin-top: 1.6rem;
    font: 500 0.8rem/1.4 var(--font-ui);
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 0.5rem 0.7rem 0;
    background: var(--bg-sunken);
    border-bottom: 1px solid var(--line);
    overflow-x: auto;
  }
  .tab {
    font: 500 0.72rem/1 var(--font-ui);
    padding: 0.42rem 0.8rem;
    color: var(--ink-soft);
    white-space: nowrap;
  }
  .tab.active {
    font-weight: 600;
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    color: var(--accent);
  }

  .body {
    display: grid;
    grid-template-columns: 1.5fr 1fr;
    gap: 1.4rem;
    padding: 1rem 1.2rem 1.2rem;
    align-items: start;
  }

  .thead,
  .trow {
    display: grid;
    grid-template-columns:
      minmax(0, 1.5fr) minmax(0, 0.65fr) minmax(0, 1fr) minmax(0, 0.7fr)
      minmax(0, 0.6fr);
    gap: 0.6rem;
    padding: 0.45rem 0.6rem;
    align-items: center;
  }
  .thead {
    background: var(--accent);
    color: var(--accent-ink);
    border-radius: 6px;
    font-weight: 700;
  }
  .trow {
    border-bottom: 1px solid var(--line);
  }
  .thead span,
  .trow span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .num {
    text-align: right;
  }
  .cat {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }
  .note {
    color: var(--gold);
    font-weight: 600;
    font-size: 0.72rem;
  }
  .tfoot {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.6rem;
    padding: 0.6rem 0.6rem 0;
    font-weight: 700;
  }
  .sum {
    color: var(--accent);
  }

  .rail {
    display: grid;
    gap: 0.8rem;
  }
  .chart {
    display: flex;
    align-items: flex-end;
    gap: 0.65rem;
    height: 110px;
    padding: 0.8rem 0.9rem;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius-m);
  }
  .bar {
    flex: 1;
    border-radius: 4px 4px 0 0;
  }
  .rail-note {
    font: 500 0.8rem/1.5 var(--font-ui);
    color: var(--ink-soft);
    margin: 0;
  }
  .chips {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  @media (max-width: 760px) {
    .body {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 560px) {
    .thead,
    .trow {
      grid-template-columns:
        minmax(0, 1.5fr) minmax(0, 0.65fr) minmax(0, 1fr) minmax(0, 0.7fr);
    }
    .notes {
      display: none;
    }
  }
</style>
