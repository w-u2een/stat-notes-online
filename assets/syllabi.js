"use strict";

// Retain the existing key and item IDs so saved review progress survives updates.
function createSyllabusReviewStore(storage, key) {
  let saved = new Set();
  let persistent = Boolean(storage);
  function read() {
    if (!persistent) return new Set(saved);
    try {
      const data = JSON.parse(storage.getItem(key) || "null");
      return data?.version === 1 && Array.isArray(data.checked)
        ? new Set(data.checked.filter(id => typeof id === "string" && id.length < 200)) : new Set();
    } catch (error) {
      if (error?.name !== "SyntaxError") persistent = false;
      return new Set(saved);
    }
  }
  saved = read();
  return {
    get persistent() { return persistent; },
    get checked() { return saved; },
    isChecked(id) { return saved.has(id); },
    refresh() { saved = read(); },
    setChecked(id, value) {
      saved = read();
      if (value) saved.add(id); else saved.delete(id);
      if (!persistent) return;
      try { storage.setItem(key, JSON.stringify({ version:1, checked:[...saved].sort() })); }
      catch { persistent = false; }
    }
  };
}

(() => {
  const catalog = JSON.parse(document.getElementById("syllabusCatalog").textContent);
  const byCourse = new Map(catalog.map(course => [course.id, course]));
  const byReview = new Map();
  catalog.forEach(course => course.units.forEach(unit => {
    unit.ids = unit.checks ? unit.checks.split(" ").map(id => course.id + "-" + id) : [];
    unit.ids.forEach(id => byReview.set(id, {course:course.id, unit:unit.id}));
  }));
  const $ = id => document.getElementById(id);
  const tabs = [...document.querySelectorAll(".syllabus-tab")];
  const container = $("syllabusCourses");
  const search = $("syllabusSearch");
  const result = $("syllabusResult");
  const empty = $("syllabusEmpty");
  const clear = $("clearSearch");
  const expand = $("expandAll");
  const collapse = $("collapseAll");
  const print = $("printCourse");
  const REVIEW_KEY = "georgia-notes-online.syllabi.review.v1";
  let storage = null;
  try { storage = window.localStorage; } catch {}
  const review = createSyllabusReviewStore(storage, REVIEW_KEY);
  const cache = new Map();
  const openUnits = new Map(catalog.map(course => [course.id, new Set()]));
  let active = null;
  let panel = null;
  let data = null;
  let unitElements = new Map();
  let visit = 0;
  let timer;
  let searchOpenStates = null;
  let queryTokens = [];
  let renderFrame = 0;
  const renderQueue = new Set();

  function loadCourse(course, retry = false) {
    if (cache.has(course.id)) return cache.get(course.id);
    const promise = fetch(course.url, {cache:retry ? "reload" : "force-cache"})
      .then(response => { if (!response.ok) throw new Error("Course unavailable"); return response.json(); })
      .then(value => {
        if (value.id !== course.id || !value.shell || !value.units) throw new Error("Invalid course data");
        return value;
      });
    cache.set(course.id, promise);
    promise.catch(() => { if (cache.get(course.id) === promise) cache.delete(course.id); });
    return promise;
  }

  function counts() {
    const course = new Map(), unit = new Map();
    let total = 0;
    review.checked.forEach(id => {
      const owner = byReview.get(id);
      if (!owner) return;
      total++;
      course.set(owner.course, (course.get(owner.course) || 0) + 1);
      unit.set(owner.unit, (unit.get(owner.unit) || 0) + 1);
    });
    return {course, unit, total};
  }
  function restoreChecks(root) {
    root.querySelectorAll(".review-check").forEach(input => {
      input.checked = review.isChecked(input.dataset.reviewId);
      input.closest(".review-item").classList.toggle("is-reviewed", input.checked);
    });
  }
  function renderProgress(restore = false, changedUnit = null) {
    const state = counts();
    $("overallReviewStatus").textContent = "全部课程已复习 " + state.total + " / " + byReview.size + " 条";
    const saveStatus = $("reviewSaveStatus");
    saveStatus.textContent = review.persistent ? "勾选后自动保存在当前浏览器，不会同步到其他设备。" : "当前浏览器无法保存，勾选进度仅在本次打开期间保留。";
    saveStatus.classList.toggle("is-warning", !review.persistent);
    if (!panel) return;
    if (restore) restoreChecks(panel);
    active.units.forEach(unit => {
      if (changedUnit && changedUnit !== unit.id) return;
      const element = unitElements.get(unit.id), done = state.unit.get(unit.id) || 0;
      const badge = element.querySelector("[data-review-unit-count]");
      badge.textContent = done + " / " + unit.ids.length;
      badge.setAttribute("aria-label", "已复习 " + done + " 条，共 " + unit.ids.length + " 条");
      element.classList.toggle("is-reviewed", unit.ids.length > 0 && done === unit.ids.length);
    });
    const done = state.course.get(active.id) || 0;
    const total = active.units.reduce((sum, unit) => sum + unit.ids.length, 0);
    panel.querySelector("[data-review-course-count]").textContent = "已复习 " + done + " / " + total + " 条";
    panel.querySelector("[data-review-course-percent]").textContent = (total ? Math.round(done / total * 100) : 0) + "%";
    panel.querySelector("[data-review-course-bar]").value = done;
  }

  const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function removeHighlights(unit) {
    const parents = new Set();
    unit.querySelectorAll("mark.search-hit").forEach(mark => {
      parents.add(mark.parentNode);
      mark.replaceWith(document.createTextNode(mark.textContent));
    });
    parents.forEach(parent => parent.normalize());
  }
  function highlight(unit) {
    if (!queryTokens.length) return;
    const pattern = new RegExp(queryTokens.slice().sort((a,b) => b.length-a.length).map(escapeRegExp).join("|"), "gi");
    const walker = document.createTreeWalker(unit, NodeFilter.SHOW_TEXT), nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeValue.trim() && !node.parentElement.closest("script,style,mark")) nodes.push(node);
    }
    nodes.forEach(node => {
      pattern.lastIndex = 0;
      if (!pattern.test(node.nodeValue)) return;
      pattern.lastIndex = 0;
      const fragment = document.createDocumentFragment();
      let offset = 0, match;
      while ((match = pattern.exec(node.nodeValue))) {
        fragment.append(document.createTextNode(node.nodeValue.slice(offset, match.index)));
        const mark = document.createElement("mark");
        mark.className = "search-hit";
        mark.textContent = match[0];
        fragment.append(mark);
        offset = pattern.lastIndex;
      }
      fragment.append(document.createTextNode(node.nodeValue.slice(offset)));
      node.replaceWith(fragment);
    });
  }
  function hydrate(unit, withHighlights = true) {
    if (!unit.dataset.hydrated) {
      const body = unit.querySelector(".unit-body");
      body.innerHTML = data.units[unit.id].html;
      unit.dataset.hydrated = "true";
      restoreChecks(body);
    }
    if (withHighlights) { removeHighlights(unit); highlight(unit); }
  }
  function drainQueue() {
    renderFrame = 0;
    const start = performance.now();
    while (renderQueue.size && performance.now() - start < 8) {
      const unit = renderQueue.values().next().value;
      renderQueue.delete(unit);
      if (panel?.contains(unit) && unit.open && !unit.hidden) hydrate(unit);
    }
    if (renderQueue.size) renderFrame = requestAnimationFrame(drainQueue);
  }
  function queueUnit(unit) {
    renderQueue.add(unit);
    if (!renderFrame) renderFrame = requestAnimationFrame(drainQueue);
  }
  function cancelRendering() {
    cancelAnimationFrame(renderFrame);
    renderFrame = 0;
    renderQueue.clear();
  }
  function filter() {
    if (!panel) return;
    cancelRendering();
    const query = search.value.trim().toLocaleLowerCase();
    queryTokens = query.split(/\s+/).filter(Boolean);
    if (query && searchOpenStates === null) searchOpenStates = new Map([...unitElements].map(([id, el]) => [id, el.open]));
    let matches = 0;
    unitElements.forEach(unit => {
      removeHighlights(unit);
      unit.hidden = !queryTokens.every(token => data.units[unit.id].text.includes(token));
      if (!query && searchOpenStates?.has(unit.id)) unit.open = searchOpenStates.get(unit.id);
      if (!unit.hidden) {
        matches++;
        if (query) unit.open = true;
        if (unit.open) queueUnit(unit);
      }
    });
    if (!query) searchOpenStates = null;
    panel.querySelectorAll(".syllabus-group").forEach(group => {
      group.hidden = ![...group.querySelectorAll(".syllabus-unit")].some(unit => !unit.hidden);
    });
    result.textContent = query ? matches + " / " + active.units.length + " 个教学单元匹配" : active.units.length + " 个教学单元";
    empty.hidden = matches !== 0;
    clear.hidden = !query;
    expand.disabled = collapse.disabled = matches === 0;
  }
  function setControls(ready) {
    search.disabled = expand.disabled = collapse.disabled = print.disabled = !ready;
  }
  async function setActive(id, targetId = "", scroll = false, retry = false) {
    const next = byCourse.get(id) || catalog[0];
    const currentVisit = ++visit;
    clearTimeout(timer);
    cancelRendering();
    if (active && panel) {
      openUnits.set(active.id, new Set([...unitElements].filter(([unitId, unit]) => searchOpenStates ? searchOpenStates.get(unitId) : unit.open).map(([unitId]) => unitId)));
    }
    active = next;
    panel = null;
    data = null;
    unitElements = new Map();
    search.value = "";
    searchOpenStates = null;
    queryTokens = [];
    empty.hidden = clear.hidden = true;
    setControls(false);
    tabs.forEach(tab => {
      const selected = tab.dataset.course === active.id;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    $("syllabusSearchLabel").textContent = "在" + active.name + "大纲中搜索";
    search.setAttribute("aria-controls", active.id);
    $("currentCourseStatus").textContent = active.year + "版 · " + active.units.length + " 个教学单元";
    document.title = active.name + "大纲 | stat notes-online";
    result.textContent = "正在加载" + active.name + "大纲…";
    container.setAttribute("aria-busy", "true");
    const loading = document.createElement("p");
    loading.className = "syllabus-hint";
    loading.textContent = "正在加载" + active.name + "大纲…";
    container.replaceChildren(loading);
    try {
      const loaded = await loadCourse(next, retry);
      if (currentVisit !== visit) return;
      data = loaded;
      const template = document.createElement("template");
      template.innerHTML = data.shell;
      panel = template.content.querySelector(".syllabus-course");
      unitElements = new Map([...panel.querySelectorAll(".syllabus-unit")].map(unit => [unit.id, unit]));
      container.replaceChildren(panel);
      container.setAttribute("aria-busy", "false");
      setControls(true);
      openUnits.get(active.id).forEach(unitId => { const unit = unitElements.get(unitId); if (unit) unit.open = true; });
      renderProgress(true);
      filter();
      const target = unitElements.get(targetId);
      if (target) { target.open = true; hydrate(target); if (scroll) target.scrollIntoView({block:"start"}); }
    } catch {
      if (currentVisit !== visit) return;
      container.setAttribute("aria-busy", "false");
      loading.textContent = "大纲暂时未能加载，请检查网络后重试；仍可切换到其他课程。";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "syllabus-action";
      button.textContent = "重新加载";
      button.addEventListener("click", () => setActive(next.id, targetId, scroll, true));
      container.replaceChildren(loading, button);
      result.textContent = "加载未完成";
    }
  }
  function useHash(scroll) {
    let hash = "";
    try { hash = decodeURIComponent(location.hash.slice(1)); } catch {}
    const course = catalog.find(item => item.id === hash || item.units.some(unit => unit.id === hash)) || catalog[0];
    if (active?.id === course.id && panel) {
      const target = unitElements.get(hash);
      if (target) {
        if (search.value) { search.value = ""; filter(); }
        target.open = true;
        hydrate(target);
        if (scroll) target.scrollIntoView({block:"start"});
      }
      return;
    }
    setActive(course.id, hash, scroll);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", event => {
      event.preventDefault();
      if (active?.id !== tab.dataset.course || !panel) setActive(tab.dataset.course);
      history.pushState(null, "", "#" + tab.dataset.course);
    });
    const prefetch = () => loadCourse(byCourse.get(tab.dataset.course)).catch(() => {});
    tab.addEventListener("pointerenter", prefetch, {passive:true});
    tab.addEventListener("focus", prefetch);
    tab.addEventListener("keydown", event => {
      let next;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      tabs[next].click();
      tabs[next].focus();
    });
  });
  container.addEventListener("toggle", event => {
    const unit = event.target;
    if (unit.matches?.(".syllabus-unit") && unit.open) queueUnit(unit);
  }, true);
  container.addEventListener("change", event => {
    const input = event.target;
    if (!input.matches?.(".review-check")) return;
    review.setChecked(input.dataset.reviewId, input.checked);
    input.closest(".review-item").classList.toggle("is-reviewed", input.checked);
    renderProgress(false, input.closest(".syllabus-unit").id);
  });
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(filter, 120); });
  function clearSearch() { clearTimeout(timer); search.value = ""; filter(); search.focus(); }
  clear.addEventListener("click", clearSearch);
  search.addEventListener("keydown", event => { if (event.key === "Escape") clearSearch(); });
  expand.addEventListener("click", () => unitElements.forEach(unit => { if (!unit.hidden) { unit.open = true; queueUnit(unit); } }));
  collapse.addEventListener("click", () => { cancelRendering(); unitElements.forEach(unit => { if (!unit.hidden) unit.open = false; }); });
  print.addEventListener("click", () => window.print());
  let printState;
  window.addEventListener("beforeprint", () => {
    if (!panel) return;
    cancelRendering();
    printState = [...panel.querySelectorAll("details,.syllabus-group")].map(el => ({el, open:el.open, hidden:el.hidden}));
    unitElements.forEach(unit => hydrate(unit, false));
    printState.forEach(({el}) => { el.hidden = false; if (el.tagName === "DETAILS") el.open = true; });
  });
  window.addEventListener("afterprint", () => {
    printState?.forEach(({el, open, hidden}) => { el.hidden = hidden; if (el.tagName === "DETAILS") el.open = open; });
    printState = null;
  });
  window.addEventListener("storage", event => {
    if (event.key === REVIEW_KEY || event.key === null) { review.refresh(); renderProgress(true); }
  });
  window.addEventListener("pageshow", event => { if (event.persisted) { review.refresh(); renderProgress(true); } });
  window.addEventListener("hashchange", () => useHash(true));
  window.addEventListener("popstate", () => useHash(true));
  renderProgress();
  useHash(false);
})();
