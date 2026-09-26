(() => {
  "use strict";

  const paths = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18m-13 4h3m3 0h2m-8 3h3"/>',
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5v2"/>',
    chart: '<path d="M4 3v18h17M8 16v-4m5 4V7m5 9v-7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    chevron: '<path d="m7 10 5 5 5-5"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-11 4h0m1 8a2 2 0 0 0 4 0"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 8.5a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3v1"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.grid}</svg>`;
  const activity = [
    ["AL", "green", "Alex Lee", "completed the onboarding flow", "12 minutes ago", "Website refresh"],
    ["MK", "", "Mia Kim", "shared a new design exploration", "38 minutes ago", "Mobile experience"],
    ["JD", "blue", "James Davis", "moved the component audit to review", "1 hour ago", "Design system"],
    ["SR", "peach", "Sofia Rivera", "added feedback to the dashboard", "2 hours ago", "Website refresh"],
    ["AL", "green", "Alex Lee", "updated the navigation prototype", "3 hours ago", "Website refresh"],
    ["MK", "", "Mia Kim", "completed the accessibility checklist", "Yesterday", "Mobile experience"],
    ["JD", "blue", "James Davis", "published the September milestones", "Yesterday", "Design system"],
    ["SR", "peach", "Sofia Rivera", "shared the research summary", "Yesterday", "Discovery"],
  ];
  const milestones = [
    ["Navigation & information architecture", "Website refresh", "AL", "green", "Alex Lee", "Sep 28", "In progress", ""],
    ["Component library audit", "Design system", "JD", "blue", "James Davis", "Sep 30", "In review", "review"],
    ["Onboarding usability study", "Mobile experience", "MK", "", "Mia Kim", "Oct 02", "In progress", ""],
    ["Account settings exploration", "Website refresh", "SR", "peach", "Sofia Rivera", "Oct 05", "Planned", "review"],
    ["Color and contrast guidelines", "Design system", "JD", "blue", "James Davis", "Oct 07", "Planned", "review"],
    ["Prototype walkthrough", "Mobile experience", "AL", "green", "Alex Lee", "Oct 09", "Planned", "review"],
    ["Design handoff & documentation", "Website refresh", "MK", "", "Mia Kim", "Oct 12", "Planned", "review"],
  ];
  const project = (name, description, symbol, color, progress, status) => `
    <article class="project-row">
      <div class="project-main"><div class="project-icon ${color}">${icon(symbol)}</div><div><h3 class="project-title">${name}</h3><p class="project-description">${description}</p></div><span class="badge ${status === "In review" ? "review" : ""}">${status}</span></div>
      <div class="project-meta"><div class="progress-track" role="progressbar" aria-label="${name} completion" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill progress-${progress}"></div></div><span class="progress-label">${progress}%</span><div class="avatar-stack"><span class="avatar green">AL</span><span class="avatar">MK</span><span class="avatar blue">JD</span></div></div>
    </article>`;

  document.querySelector("#app").innerHTML = `
    <aside class="sidebar" aria-label="Workspace navigation">
      <div class="brand"><span class="brand-mark" aria-hidden="true">✳</span>northstar</div>
      <p class="workspace-label">Workspace</p>
      <nav aria-label="Main"><a class="nav-item active" href="#overview">${icon("grid")}Overview</a><a class="nav-item" href="#projects">${icon("layers")}Projects<span class="nav-count">8</span></a><a class="nav-item" href="#milestones">${icon("calendar")}Milestones</a><button class="nav-item" data-toast="Your team is all set for this week.">${icon("people")}Team</button><button class="nav-item" data-toast="The next report will be ready on Friday.">${icon("chart")}Reports</button></nav>
      <div class="sidebar-bottom"><button class="nav-item" data-toast="Demo tips: open the period menu, add a project, and scroll the activity list.">${icon("help")}Help & resources</button><div class="workspace-person"><span class="avatar green">DZ</span><div><div class="person-name">Dimitris Zoitas</div><div class="person-role">Design workspace</div></div></div><div class="environment">${document.body.dataset.version} demo</div></div>
    </aside>
    <div class="shell">
      <header class="topbar"><div class="breadcrumb">Workspace<span>/</span><strong>Overview</strong></div><div class="topbar-right"><div class="live-status" aria-label="Live demo activity"><span class="live-dot"></span>Live <span id="live-clock">00:00:00</span><span class="live-meter" aria-hidden="true"></span></div><button class="icon-button" aria-label="Notifications" data-toast="You’re all caught up. No new notifications.">${icon("bell")}</button><span class="avatar green">DZ</span></div></header>
      <main class="content" id="overview">
        <p class="eyebrow">Monday, September 28</p>
        <div class="page-heading"><div><h1>A little clarity. A lot of progress.</h1><p class="subtitle">Here’s what’s moving across your workspace this week.</p></div><div class="heading-actions"><button class="primary-button" id="new-project">${icon("plus")}New project</button></div></div>
        <div class="filter-row"><div class="tabs" role="tablist" aria-label="Overview views"><button class="tab active" role="tab" aria-selected="true" id="tab-workspace">Workspace</button><button class="tab" role="tab" aria-selected="false" tabindex="-1" id="tab-personal">My work</button><button class="tab" role="tab" aria-selected="false" tabindex="-1" id="tab-saved">Saved views</button></div><div class="period-picker"><button class="secondary-button period-button" id="period-toggle" aria-haspopup="menu" aria-expanded="false" aria-controls="period-menu">${icon("calendar")}<span id="period-label">This week</span>${icon("chevron")}</button><div class="period-menu" id="period-menu" role="menu" aria-labelledby="period-toggle" hidden><button role="menuitemradio" aria-checked="true">This week</button><button role="menuitemradio" aria-checked="false">This month</button><button role="menuitemradio" aria-checked="false">This quarter</button></div></div></div>
        <section class="metrics" aria-label="Workspace metrics"><article class="metric-card"><div class="metric-label">Active projects${icon("layers")}</div><div class="metric-value">8<small>/ 12</small></div><p class="metric-note"><strong>+2 projects</strong> this month</p></article><article class="metric-card"><div class="metric-label">Tasks completed${icon("check")}</div><div class="metric-value">64<small>/ 92</small></div><p class="metric-note"><strong>↑ 18%</strong> from last week</p></article><article class="metric-card"><div class="metric-label">Team members${icon("people")}</div><div class="metric-value">12</div><p class="metric-note"><strong>All connected</strong> and collaborating</p></article><article class="metric-card"><div class="metric-label">Time to next milestone${icon("clock")}</div><div class="metric-value">4<small>days</small></div><p class="metric-note">Website refresh · Phase 02</p></article></section>
        <div class="work-grid"><section class="panel" id="projects" aria-labelledby="projects-title"><div class="panel-header"><h2 id="projects-title">Projects in motion</h2><button class="muted-link" data-toast="You’re viewing your three most active projects.">View all</button></div><div class="project-list">${project("Website refresh", "A fresh perspective for our digital home", "grid", "", 72, "In progress")}${project("Mobile experience", "Making everyday moments feel effortless", "layers", "peach", 45, "In progress")}${project("Design system", "The foundations for building better, together", "sparkle", "blue", 88, "In review")}</div><div class="panel-footer"><button class="muted-link" id="add-project">+ Create a new project</button></div></section>
          <div><section class="panel" aria-labelledby="activity-title"><div class="panel-header"><h2 id="activity-title">Latest activity</h2><span class="badge">Team updates</span></div><div class="activity-scroll" data-diffuse-scroll="activity" tabindex="0" role="region" aria-label="Scrollable team activity">${activity.map(([initials, color, name, action, time, label]) => `<article class="activity-item"><span class="avatar ${color}">${initials}</span><div class="activity-copy"><p><strong>${name}</strong> ${action}</p><div class="activity-time">${time}</div><span class="activity-label">${label}</span></div></article>`).join("")}</div></section><aside class="panel summary"><div class="summary-icon">${icon("sparkle")}</div><h2>Small steps, shared momentum.</h2><p>Your team completed <strong>16 tasks</strong> this week. A thoughtful pace adds up to meaningful progress.</p><button class="muted-link" data-toast="Weekly summary: 16 tasks completed across 3 active projects.">See your weekly summary →</button></aside></div>
        </div>
        <section class="panel milestones" id="milestones" aria-labelledby="milestones-title"><div class="panel-header"><h2 id="milestones-title">Coming up next</h2><span class="muted-link">September — October</span></div><div class="table-wrap"><table><thead><tr><th scope="col">Milestone</th><th scope="col">Project</th><th scope="col">Owner</th><th scope="col">Due date</th><th scope="col">Status</th></tr></thead><tbody>${milestones.map(([name, projectName, initials, color, owner, date, status, variant]) => `<tr><td>${name}</td><td>${projectName}</td><td><span class="avatar ${color}">${initials}</span>${owner}</td><td>${date}</td><td><span class="badge ${variant}">${status}</span></td></tr>`).join("")}</tbody></table></div></section>
        <footer class="footnote"><span>Thoughtfully organized. Ready for what’s next.</span><a href="#overview">Back to top ↑</a></footer>
      </main>
    </div>
    <dialog id="project-dialog" aria-labelledby="dialog-title" aria-describedby="dialog-description"><div class="dialog-header"><h2 id="dialog-title">A new beginning.</h2><button class="icon-button" id="close-dialog" aria-label="Close new project dialog">${icon("close")}</button></div><form class="dialog-body" id="project-form"><p id="dialog-description">Give your next project a home. Start with a name and a little context.</p><div class="form-field"><label for="project-name">Project name</label><input id="project-name" name="name" placeholder="Something worth making" maxlength="80" required autocomplete="off" /></div><div class="form-field"><label for="project-description">A short description <span>(optional)</span></label><textarea id="project-description" name="description" placeholder="What are we working toward?" maxlength="300"></textarea></div><div class="dialog-footer"><button type="button" class="secondary-button" id="cancel-dialog">Cancel</button><button type="submit" class="primary-button">Create project${icon("arrow")}</button></div></form></dialog>
    <div class="toast" role="status" aria-live="polite"></div>`;

  let toastTimer;
  const toast = (message) => {
    clearTimeout(toastTimer);
    document.querySelector(".toast").textContent = message;
    toastTimer = setTimeout(() => { document.querySelector(".toast").textContent = ""; }, 4500);
  };
  document.querySelectorAll("[data-toast]").forEach((button) => {
    button.addEventListener("click", () => toast(button.dataset.toast));
  });

  const clock = document.querySelector("#live-clock");
  const updateClock = () => {
    clock.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
  };
  updateClock();
  setInterval(updateClock, 1000);

  const menuToggle = document.querySelector("#period-toggle");
  const menu = document.querySelector("#period-menu");
  const menuItems = [...menu.querySelectorAll("button")];
  const closeMenu = (restoreFocus = false) => {
    menu.hidden = true;
    menuToggle.setAttribute("aria-expanded", "false");
    if (restoreFocus) menuToggle.focus();
  };
  const openMenu = () => {
    menu.hidden = false;
    menuToggle.setAttribute("aria-expanded", "true");
    menuItems.find((item) => item.getAttribute("aria-checked") === "true").focus();
  };
  menuToggle.addEventListener("click", () => menu.hidden ? openMenu() : closeMenu(true));
  menuToggle.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openMenu(); }
  });
  menu.addEventListener("keydown", (event) => {
    const index = menuItems.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      menuItems[(index + (event.key === "ArrowDown" ? 1 : -1) + menuItems.length) % menuItems.length].focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      menuItems[event.key === "Home" ? 0 : menuItems.length - 1].focus();
    } else if (event.key === "Escape") { event.preventDefault(); closeMenu(true); }
    else if (event.key === "Tab") closeMenu();
  });
  menuItems.forEach((item) => item.addEventListener("click", () => {
    menuItems.forEach((other) => other.setAttribute("aria-checked", String(other === item)));
    document.querySelector("#period-label").textContent = item.textContent;
    closeMenu(true);
  }));
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".period-picker")) closeMenu();
  });

  const tabs = [...document.querySelectorAll(".tab")];
  const selectTab = (tab) => {
    tabs.forEach((other) => {
      const active = other === tab;
      other.classList.toggle("active", active);
      other.setAttribute("aria-selected", String(active));
      other.tabIndex = active ? 0 : -1;
    });
    if (tab.id !== "tab-workspace") toast(`${tab.textContent}: the demo keeps the same sample content for comparison.`);
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const next = tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
        selectTab(next);
        next.focus();
      }
    });
  });

  const dialog = document.querySelector("#project-dialog");
  for (const id of ["new-project", "add-project"]) {
    document.getElementById(id).addEventListener("click", () => { closeMenu(); dialog.showModal(); });
  }
  for (const id of ["close-dialog", "cancel-dialog"]) {
    document.getElementById(id).addEventListener("click", () => dialog.close());
  }
  document.querySelector("#project-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.querySelector("#project-name").value.trim();
    if (!name) { document.querySelector("#project-name").focus(); return; }
    dialog.close();
    toast(`“${name}” is ready. This demo does not save projects.`);
    event.target.reset();
  });
})();
