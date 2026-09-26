(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const production = document.body.dataset.version === "production";
  const other = production ? "prototype" : "production";
  const statusLabels = {review:"Ready for review", progress:"In progress", planned:"Planned"};
  const seed = [
    {id:"aurora", name:"Aurora onboarding", owner:"Maya Lee", initials:"ML", status:"review", progress:86, date:"2026-10-09", art:"aurora", description:"A more considered first five minutes.", note:"Keep the first step focused. Make the next action feel obvious."},
    {id:"search", name:"Search, reimagined", owner:"Jordan Tan", initials:"JT", status:"progress", progress:62, date:"2026-10-14", art:"search", description:"Less looking. More finding.", note:"Check the empty search state and the keyboard flow."},
    {id:"studio", name:"Studio permissions", owner:"Sam Patel", initials:"SP", status:"planned", progress:24, date:"2026-10-21", art:"studio", description:"The right space for every teammate.", note:"Make roles clear before anyone sends an invitation."},
    {id:"insights", name:"A clearer weekly summary", owner:"Alex Kim", initials:"AK", status:"review", progress:91, date:"2026-10-12", art:"aurora", description:"The useful signal, all in one place.", note:"Check long metric labels at a narrow width."},
    {id:"billing", name:"A simpler billing journey", owner:"Maya Lee", initials:"ML", status:"progress", progress:48, date:"2026-10-19", art:"search", description:"A little less admin, a little more clarity.", note:"Review the payment error message in context."},
    {id:"mobile", name:"A workspace that goes with you", owner:"Jordan Tan", initials:"JT", status:"progress", progress:35, date:"2026-10-23", art:"studio", description:"Good work, wherever it happens.", note:"Check navigation and drawers at mobile widths."}
  ];
  let releases = structuredClone(seed);
  let view = "overview", scene = "normal", longCopy = false, order = "default", selected = null, menuId = null, returnFocus = null, toastTimer;
  const escape = value => String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  const initials = name => name.split(" ").map(part => part[0]).slice(0,2).join("");
  const displayName = release => longCopy && release.id === "aurora" ? "Aurora onboarding — a thoughtful first-run experience for every new workspace and its teammates" : release.name;
  const dateLabel = value => value ? new Date(value + "T12:00:00Z").toLocaleDateString("en-US", {month:"short",day:"2-digit",timeZone:"UTC"}) : "No date";
  const pill = status => '<span class="status-pill ' + status + '">' + statusLabels[status] + '</span>';
  function art(name) {
    const contents = name === "aurora"
      ? '<rect width="480" height="220" fill="#d7e3fd"/><circle cx="257" cy="157" r="98" fill="#406cdb"/><circle cx="257" cy="157" r="63" fill="#94b0ee"/><circle cx="257" cy="157" r="32" fill="#e8efff"/><path d="M55 185V57h72v128" stroke="#f7f9ff" stroke-width="31" stroke-linecap="round" fill="none"/><path d="m370 54 21 19-21 19-21-19Z" fill="#7596e0"/>'
      : name === "search"
      ? '<rect width="480" height="220" fill="#f3d8c5"/><circle cx="276" cy="129" r="90" fill="#bf684f"/><circle cx="276" cy="129" r="64" fill="#edb89c"/><path d="m170 220 118-145 85 145" fill="#f8e9d8"/><rect x="70" y="35" width="45" height="145" rx="22" fill="#e89570" transform="rotate(18 92 108)"/><circle cx="390" cy="43" r="13" fill="#aa5d44"/>'
      : '<rect width="480" height="220" fill="#e5dff2"/><path d="M157 242V119a83 83 0 0 1 166 0v123" stroke="#9380b6" stroke-width="45" fill="none"/><path d="M157 242V119a83 83 0 0 1 166 0v123" stroke="#bdaed7" stroke-width="15" fill="none"/><rect x="63" y="127" width="74" height="74" rx="13" fill="#f4efe1" transform="rotate(-18 100 164)"/><circle cx="384" cy="60" r="32" fill="#c3b6db"/><circle cx="384" cy="60" r="15" fill="#ece7f6"/>';
    return '<svg viewBox="0 0 480 220" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' + contents + '</svg>';
  }
  function card(release) {
    const description = production && release.id === "aurora" ? "Improve the onboarding experience." : release.description;
    return '<button class="release-card" data-open="' + release.id + '" data-component="ReleaseCard" aria-label="Open ' + escape(displayName(release)) + '"><div class="card-art">' + art(release.art) + '</div><div class="card-body"><div class="card-title-row"><h3>' + escape(displayName(release)) + '</h3>' + pill(release.status) + '</div><p>' + escape(description) + '</p><div class="card-footer"><div class="card-people" aria-label="' + escape(release.owner) + ' and Alex Kim"><span class="avatar">' + release.initials + '</span><span class="avatar">AK</span></div><span>Target ' + dateLabel(release.date) + '</span></div></div></button>';
  }
  function row(release) {
    return '<tr data-release="' + release.id + '" data-component="ReleaseTableRow"><td><button class="release-name-button" data-open="' + release.id + '"><span class="mini-art art-' + release.art + '" aria-hidden="true">' + (release.art === "aurora" ? "◔" : release.art === "search" ? "◒" : "∩") + '</span><span>' + escape(displayName(release)) + '</span></button></td><td><span class="owner-cell"><span class="avatar">' + release.initials + '</span>' + escape(release.owner.split(" ")[0]) + '</span></td><td>' + pill(release.status) + '</td><td><span class="progress-cell" aria-label="' + release.progress + '% ready"><span class="progress-track" aria-hidden="true"><span style="width:' + release.progress + '%"></span></span>' + release.progress + '%</span></td><td>' + dateLabel(release.date) + '</td><td><button class="icon-button row-action" data-menu="' + release.id + '" aria-label="Actions for ' + escape(displayName(release)) + '" aria-expanded="false" aria-controls="row-menu">' + icon("dots") + '</button></td></tr>';
  }
  function currentUrl(variant) {
    const url = new URL(location.href);
    if (variant) url.pathname = url.pathname.replace(/(?:prototype|production)\.html$/, variant + ".html");
    url.hash = "";
    url.search = "";
    if (view !== "overview") url.searchParams.set("view", view);
    if (scene !== "normal") url.searchParams.set("state", scene);
    if (longCopy) url.searchParams.set("copy", "long");
    if (selected && seed.some(release => release.id === selected)) url.searchParams.set("detail", selected);
    return url.href;
  }
  function syncUrl() {
    try { history.replaceState(null, "", currentUrl()); } catch {}
    $("other-version").href = currentUrl(other);
  }
  function closeMenu(restore = false) {
    const trigger = document.querySelector('[data-menu="' + menuId + '"]');
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    $("row-menu").hidden = true;
    if (restore && trigger) trigger.focus();
    menuId = null;
  }
  function render() {
    closeMenu();
    const query = $("search").value.toLocaleLowerCase().trim();
    const filter = $("status-filter").value;
    let visible = releases.filter(release => (filter === "all" || release.status === filter) && (displayName(release) + " " + release.owner).toLocaleLowerCase().includes(query));
    if (order !== "default") visible.sort((a,b) => displayName(a).localeCompare(displayName(b)) * (order === "asc" ? 1 : -1));
    const count = visible.length;
    document.body.dataset.state = scene;
    document.body.dataset.long = String(longCopy);
    document.body.dataset.view = view;
    $("breadcrumb-current").textContent = view === "overview" ? "Overview" : "Releases";
    $("page-title").textContent = view === "releases" ? "Good work, in progress." : production ? "Good morning Alex" : "Good morning, Alex.";
    $("metrics").hidden = view !== "overview";
    $("spotlight-section").hidden = view !== "overview";
    $("nav-count").textContent = releases.length;
    $("active-count").textContent = releases.length;
    $("review-count").textContent = releases.filter(release => release.status === "review").length;
    document.querySelectorAll(".nav [data-view]").forEach(button => {
      const active = button.dataset.view === view;
      button.classList.toggle("active", active);
      active ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current");
    });
    $("spotlight").innerHTML = visible.slice(0, 3).map(card).join("");
    $("release-rows").innerHTML = visible.map(row).join("");
    $("result-count").textContent = count;
    $("table-summary").textContent = "Showing " + count + " of " + releases.length + " releases";
    $("sort-arrow").textContent = order === "asc" ? "↑" : order === "desc" ? "↓" : "↕";
    $("sort-name").setAttribute("aria-label", "Sort release names " + (order === "asc" ? "descending" : "ascending"));
    $("sort-name").closest("th").setAttribute("aria-sort", order === "asc" ? "ascending" : order === "desc" ? "descending" : "none");
    const empty = scene === "empty" || !count;
    $("results").hidden = scene === "loading" || scene === "error" || empty;
    $("loading-panel").hidden = scene !== "loading";
    $("state-panel").hidden = !(scene === "error" || (empty && scene !== "loading"));
    if (scene === "error") {
      $("state-panel").innerHTML = '<span class="state-symbol" aria-hidden="true">!</span><h2>' + (production ? "Something went wrong" : "Your releases could not be loaded") + '</h2><p>' + (production ? "An error occurred. Try again." : "The workspace is still here. Try loading the release list again to pick up where you left off.") + '</p><button class="button ' + (production ? "secondary" : "primary") + '" id="retry-load">Try again ' + icon("arrow") + '</button>';
    } else if (empty) {
      const filtered = scene !== "empty";
      $("state-panel").innerHTML = '<span class="state-symbol" aria-hidden="true">◇</span><h2>' + (filtered ? "No matching releases" : production ? "Nothing to show" : "Your next good idea starts here") + '</h2><p>' + (filtered ? "Try another name, owner, or status to find the release you need." : production ? "Add an item to continue." : "Create a release to give your next product update a home. A name is all you need to get started.") + '</p><button class="button primary" id="' + (filtered ? "clear-filters" : "empty-create") + '">' + (filtered ? "Clear filters" : production ? "New item" : "Create your first release") + icon("arrow") + '</button>';
    }
    $("demo-state").value = scene;
    $("long-copy").checked = longCopy;
    syncUrl();
  }
  function toast(title, copy = "", persistent = false) {
    clearTimeout(toastTimer);
    $("toast-title").textContent = title;
    $("toast-copy").textContent = copy;
    $("toast-copy").hidden = !copy;
    $("toast").hidden = false;
    if (!persistent) toastTimer = setTimeout(() => { $("toast").hidden = true; }, 8000);
  }
  function dismissToast() { clearTimeout(toastTimer); $("toast").hidden = true; }
  function setScene(next) {
    scene = ["normal", "loading", "empty", "error", "success"].includes(next) ? next : "normal";
    dismissToast();
    if (scene === "success") toast(production ? "Saved" : "Release updated", production ? "" : "Your changes are ready for the team to review.", true);
    render();
  }
  function setView(next) {
    view = next === "releases" ? "releases" : "overview";
    $("sidebar").classList.remove("is-open");
    $("mobile-menu").setAttribute("aria-expanded", "false");
    render();
  }
  function openCreate() {
    closeMenu();
    $("notifications").hidden = true;
    $("notifications-button").setAttribute("aria-expanded", "false");
    $("lab-panel").hidden = true;
    $("lab-toggle").setAttribute("aria-expanded", "false");
    returnFocus = document.activeElement;
    $("create-dialog").showModal();
    $("release-name").focus();
  }
  function openDetail(id) {
    const release = releases.find(item => item.id === id);
    if (!release) return;
    returnFocus = document.activeElement;
    closeMenu();
    selected = id;
    $("detail-link-feedback").textContent = "";
    $("detail-art").innerHTML = art(release.art);
    $("detail-title").textContent = displayName(release);
    $("detail-description").textContent = release.description;
    $("detail-owner").textContent = release.owner;
    $("detail-date").textContent = dateLabel(release.date);
    $("detail-status").className = "status-pill " + release.status;
    $("detail-status").textContent = statusLabels[release.status];
    $("detail-status-select").value = release.status;
    $("detail-note").value = release.note || "";
    $("check-design").checked = release.checks?.design ?? true;
    $("check-copy").checked = release.checks?.copy ?? false;
    $("check-keyboard").checked = release.checks?.keyboard ?? false;
    $("detail-dialog").showModal();
    syncUrl();
  }
  function reset() {
    releases = structuredClone(seed);
    selected = null; menuId = null; order = "default"; view = "overview"; longCopy = false; scene = "normal";
    document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
    $("create-form").reset();
    $("name-error").hidden = true; $("form-summary").hidden = true;
    $("release-name").removeAttribute("aria-invalid");
    $("search").value = ""; $("status-filter").value = "all";
    $("notifications").hidden = true; $("notifications").classList.remove("is-read");
    $("notifications-button").setAttribute("aria-expanded", "false");
    $("notifications-button").setAttribute("aria-label", "Notifications, 2 unread");
    document.querySelector(".notification-dot").hidden = false;
    $("mark-read").textContent = "Mark all read";
    $("lab-feedback").textContent = "Back to the original scene.";
    dismissToast(); render();
    window.scrollTo({top:0,behavior:"instant"});
  }
  document.querySelectorAll(".create-label").forEach(element => {element.textContent = production ? "New item" : "Create release";});
  if (production) {
    $("create-title").textContent = "Add new item";
    $("form-intro").textContent = "Fill out the information below.";
    $("release-name").placeholder = "Enter name";
    $("save-release").innerHTML = "Save " + icon("arrow");
  }
  const activity = [
    ["ML","Maya Lee","left feedback on Aurora onboarding","12 minutes ago"],
    ["JT","Jordan Tan","updated the search results layout","35 minutes ago"],
    ["SP","Sam Patel","shared a new permissions flow","1 hour ago"],
    ["AK","Alex Kim","added notes to the weekly summary","2 hours ago"],
    ["ML","Maya Lee","checked the billing empty state","3 hours ago"],
    ["JT","Jordan Tan","tested keyboard navigation","Yesterday"],
    ["SP","Sam Patel","reviewed the mobile sidebar","Yesterday"],
    ["AK","Alex Kim","created the next release milestone","Monday"]
  ];
  $("activity-list").innerHTML = activity.map(item => '<article class="activity-row"><span class="avatar">' + item[0] + '</span><div><p><strong>' + item[1] + '</strong> ' + item[2] + '</p><small>' + item[3] + '</small></div></article>').join("");
  $("search").addEventListener("input", render);
  $("status-filter").addEventListener("change", render);
  $("sort-name").addEventListener("click", () => {order = order === "asc" ? "desc" : "asc"; render(); $("sort-name").focus();});
  document.querySelectorAll(".nav [data-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
  $("view-all").addEventListener("click", () => setView("releases"));
  $("create-release").addEventListener("click", openCreate);
  $("finish-loading").addEventListener("click", () => setScene("normal"));
  $("state-panel").addEventListener("click", event => {
    if (event.target.closest("#retry-load")) setScene("normal");
    if (event.target.closest("#clear-filters")) { $("search").value = ""; $("status-filter").value = "all"; render(); $("search").focus(); }
    if (event.target.closest("#empty-create")) openCreate();
  });
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(button.dataset.close).close()));
  for (const id of ["detail-dialog","create-dialog"]) $(id).addEventListener("close", () => {
    if (id === "detail-dialog") { selected = null; syncUrl(); }
    if (returnFocus?.isConnected) returnFocus.focus();
  });
  $("results").addEventListener("click", event => {
    const opener = event.target.closest("[data-open]");
    if (opener) { openDetail(opener.dataset.open); return; }
    const action = event.target.closest("[data-menu]");
    if (!action) return;
    const id = action.dataset.menu;
    const wasOpen = menuId === id && !$("row-menu").hidden;
    closeMenu();
    if (wasOpen) return;
    menuId = id; $("row-menu").hidden = false; action.setAttribute("aria-expanded", "true");
    const rect = action.getBoundingClientRect();
    $("row-menu").style.left = Math.max(12, Math.min(innerWidth - 240, rect.right - 228)) + "px";
    $("row-menu").style.top = Math.max(12, Math.min(innerHeight - 116, rect.bottom + 4)) + "px";
    $("menu-open").focus();
  });
  $("menu-open").addEventListener("click", () => openDetail(menuId));
  $("menu-review").addEventListener("click", () => {
    const release = releases.find(item => item.id === menuId);
    if (release) { release.status = "review"; render(); toast(production ? "Saved" : "Ready for a fresh pair of eyes", production ? "" : release.name + " is ready for review."); }
  });
  $("save-detail").addEventListener("click", () => {
    const release = releases.find(item => item.id === selected);
    if (!release) return;
    release.status = $("detail-status-select").value;
    release.note = $("detail-note").value;
    release.checks = {design:$("check-design").checked, copy:$("check-copy").checked, keyboard:$("check-keyboard").checked};
    $("detail-dialog").close(); render();
    toast(production ? "Saved" : "Release updated", production ? "" : "Your note and checklist stay with this release.");
  });
  $("create-form").addEventListener("submit", async event => {
    event.preventDefault();
    const name = $("release-name").value.trim();
    $("name-error").hidden = true; $("form-summary").hidden = true;
    $("release-name").removeAttribute("aria-invalid");
    if (name.length < 3) {
      $("release-name").setAttribute("aria-invalid","true");
      const error = production ? $("form-summary") : $("name-error");
      error.textContent = production ? "Please enter a valid release name (at least 3 characters)." : "Give the release a name with at least 3 characters, so the team can recognise it.";
      error.hidden = false;
      $("release-name").setAttribute("aria-describedby", error.id);
      $("release-name").focus();
      return;
    }
    const submit = $("save-release"), original = submit.innerHTML;
    submit.disabled = true; submit.textContent = production ? "Saving…" : "Creating release…";
    await new Promise(resolve => setTimeout(resolve, 700));
    const owner = $("release-owner").value;
    releases.unshift({id:"new-" + Date.now(),name,owner,initials:initials(owner),status:"planned",progress:0,date:$("release-date").value,art:"studio",description:$("release-notes").value.trim() || "A new idea, with room to grow.",note:""});
    $("create-dialog").close(); $("create-form").reset(); submit.disabled = false; submit.innerHTML = original;
    $("search").value = ""; $("status-filter").value = "all"; scene = "normal"; order = "default";
    render(); toast(production ? "Saved" : "Your next release has a home", production ? "" : name + " is ready for its first task.");
  });
  $("notifications-button").addEventListener("click", () => {
    const open = $("notifications").hidden;
    $("notifications").hidden = !open; $("notifications-button").setAttribute("aria-expanded", String(open));
    if (open) $("mark-read").focus();
  });
  $("mark-read").addEventListener("click", () => {
    $("notifications").classList.add("is-read");
    $("notifications-button").setAttribute("aria-label","Notifications, all read");
    document.querySelector(".notification-dot").hidden = true;
    $("mark-read").textContent = "All read";
  });
  $("workspace-button").addEventListener("click", () => {
    const open = $("workspace-info").hidden;
    $("workspace-info").hidden = !open; $("workspace-button").setAttribute("aria-expanded",String(open));
  });
  $("mobile-menu").addEventListener("click", () => {
    const open = $("sidebar").classList.toggle("is-open"); $("mobile-menu").setAttribute("aria-expanded",String(open));
  });
  const closeLab = () => {$("lab-panel").hidden = true; $("lab-toggle").setAttribute("aria-expanded","false"); $("lab-toggle").focus();};
  $("lab-toggle").addEventListener("click", () => {const open = $("lab-panel").hidden; $("lab-panel").hidden = !open; $("lab-toggle").setAttribute("aria-expanded",String(open));});
  $("lab-close").addEventListener("click", closeLab);
  $("demo-state").addEventListener("change", () => setScene($("demo-state").value));
  $("long-copy").addEventListener("change", () => {longCopy = $("long-copy").checked; render();});
  $("reset-demo").addEventListener("click", reset);
  $("copy-state").addEventListener("click", async () => {
    syncUrl();
    try { await navigator.clipboard.writeText(currentUrl()); $("lab-feedback").textContent = "State link copied. Change the filename to open this scene on the other page."; }
    catch { $("lab-feedback").textContent = "Copy this address: " + currentUrl(); }
  });
  $("copy-detail-link").addEventListener("click", async () => {
    syncUrl();
    try { await navigator.clipboard.writeText(currentUrl()); $("detail-link-feedback").textContent = selected?.startsWith("new-") ? "Scene link copied. New releases stay in this tab only." : "Link copied to this release and scene."; }
    catch { $("detail-link-feedback").textContent = "Copy this address: " + currentUrl(); }
  });
  $("dismiss-toast").addEventListener("click", dismissToast);
  document.addEventListener("click", event => {
    if (!event.target.closest(".notification-wrap")) { $("notifications").hidden = true; $("notifications-button").setAttribute("aria-expanded","false"); }
    if (!event.target.closest("[data-menu],#row-menu")) closeMenu();
    if ($("sidebar").classList.contains("is-open") && !event.target.closest("#sidebar,#mobile-menu")) { $("sidebar").classList.remove("is-open"); $("mobile-menu").setAttribute("aria-expanded","false"); }
  });
  window.addEventListener("scroll", () => closeMenu(), true);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      if (!$("row-menu").hidden) { event.preventDefault(); closeMenu(true); }
      if (!$("notifications").hidden) { $("notifications").hidden = true; $("notifications-button").setAttribute("aria-expanded","false"); $("notifications-button").focus(); }
      if (!$("lab-panel").hidden) closeLab();
      $("sidebar").classList.remove("is-open"); $("mobile-menu").setAttribute("aria-expanded","false");
    }
    if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target.closest("input,textarea,select,[contenteditable=true]") && !document.querySelector("dialog[open]")) { event.preventDefault(); $("search").focus(); }
  });
  const params = new URLSearchParams(location.search);
  view = params.get("view") === "releases" ? "releases" : "overview";
  longCopy = params.get("copy") === "long";
  const initialDetail = params.get("detail");
  setScene(params.get("state") || "normal");
  if (initialDetail && seed.some(release => release.id === initialDetail)) openDetail(initialDetail);
})();
