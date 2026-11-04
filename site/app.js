/* Hermes Desk landing page — small, dependency-free interactions. */
(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* Header ---------------------------------------------------------------- */
  const header = $(".site-header");
  const navToggle = $(".nav-toggle");
  const navLinks = $("#nav-links");

  const syncHeader = () => {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 8);
  };

  const closeMenu = () => {
    if (!header || !navToggle) return;
    header.classList.remove("is-open");
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.setAttribute("aria-label", "Open menu");
  };

  syncHeader();
  window.addEventListener("scroll", syncHeader, { passive: true });

  if (navToggle && header) {
    navToggle.addEventListener("click", () => {
      const open = header.classList.toggle("is-open");
      navToggle.setAttribute("aria-expanded", String(open));
      navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    });

    navLinks?.addEventListener("click", (event) => {
      if (event.target.closest("a")) closeMenu();
    });

    document.addEventListener("click", (event) => {
      if (!header.classList.contains("is-open")) return;
      if (!header.contains(event.target)) closeMenu();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && header.classList.contains("is-open")) {
        closeMenu();
        navToggle.focus();
      }
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 860) closeMenu();
    });
  }

  /* Scroll reveal --------------------------------------------------------- */
  const revealItems = $$(".reveal");
  if ("IntersectionObserver" in window && revealItems.length) {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    revealItems.forEach((item) => revealObserver.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add("is-visible"));
  }

  /* Pip: palette and state ------------------------------------------------ */
  const pip = $("#pip");
  const pipStage = $("#pip-stage");
  const caption = $("#pip-caption");
  const paletteStatus = $("#palette-status");

  const captions = {
    idle: "Ready — a familiar face.",
    thinking: "Thinking — working it through.",
    tools: "Using tools — into the satchel.",
    browsing: "Browsing — eyes on the page.",
    waiting: "Waiting — a letter for you.",
    sleep: "Resting — a quieter moment.",
  };

  const setPressed = (buttons, active) =>
    buttons.forEach((button) => {
      const on = button === active;
      button.classList.toggle("is-active", on);
      button.setAttribute("aria-pressed", String(on));
    });

  const paletteButtons = $$(".swatch");
  const stateButtons = $$(".state");

  if (pip) {
    paletteButtons.forEach((button) => {
      button.addEventListener("click", () => {
        pip.dataset.palette = button.dataset.palette;
        setPressed(paletteButtons, button);
        if (paletteStatus) {
          paletteStatus.textContent = `${button.getAttribute("aria-label")} palette selected.`;
        }
      });
    });

    stateButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const state = button.dataset.state;
        pip.dataset.state = state;
        setPressed(stateButtons, button);
        if (caption) caption.textContent = captions[state] || captions.idle;
        // Return the gaze to centre when Pip is not looking around.
        pip.style.removeProperty("--eye-x");
        pip.style.removeProperty("--eye-y");
      });
    });

    /* Pupils follow the pointer, gently. */
    let eyeFrame = 0;
    if (pipStage && !reducedMotion.matches) {
      pipStage.addEventListener("pointermove", (event) => {
        if (event.pointerType === "touch") return;
        if (pip.dataset.state === "sleep") return;

        const rect = pipStage.getBoundingClientRect();
        if (!rect.width || !rect.height) return;

        const nx = (event.clientX - rect.left) / rect.width - 0.5;
        const ny = (event.clientY - rect.top) / rect.height - 0.5;

        cancelAnimationFrame(eyeFrame);
        eyeFrame = requestAnimationFrame(() => {
          pip.style.setProperty("--eye-x", `${(nx * 11).toFixed(2)}px`);
          pip.style.setProperty("--eye-y", `${(ny * 8).toFixed(2)}px`);
        });
      });

      pipStage.addEventListener("pointerleave", () => {
        cancelAnimationFrame(eyeFrame);
        pip.style.removeProperty("--eye-x");
        pip.style.removeProperty("--eye-y");
      });
    }
  }

  /* Workspace regions ----------------------------------------------------- */
  const shotTabs = $$(".shot-tab");
  const regions = $$(".region");
  const shotPanel = $("#shot-panel");

  const selectRegion = (name, focus = false) => {
    shotTabs.forEach((tab) => {
      const active = tab.dataset.region === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    });

    regions.forEach((region) => {
      region.classList.toggle("is-active", region.dataset.region === name);
    });

    if (shotPanel) {
      const activeTab = shotTabs.find((tab) => tab.dataset.region === name);
      if (activeTab) shotPanel.setAttribute("aria-labelledby", activeTab.id);
    }
  };

  shotTabs.forEach((tab) => {
    tab.addEventListener("click", () => selectRegion(tab.dataset.region));
    tab.addEventListener("mouseenter", () => selectRegion(tab.dataset.region));
    tab.addEventListener("focus", () => selectRegion(tab.dataset.region));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const index = shotTabs.indexOf(tab);
      const next =
        event.key === "ArrowRight"
          ? shotTabs[(index + 1) % shotTabs.length]
          : shotTabs[(index - 1 + shotTabs.length) % shotTabs.length];
      selectRegion(next.dataset.region, true);
    });
  });

  /* Terminal -------------------------------------------------------------- */
  const terminal = {
    dev: {
      html: `<span class="t-prompt">$</span> git clone https://github.com/DevvGwardo/hermes-desk.git
<span class="t-prompt">$</span> cd hermes-desk
<span class="t-prompt">$</span> npm ci
<span class="t-prompt">$</span> npm run dev:local`,
      text: "git clone https://github.com/DevvGwardo/hermes-desk.git\ncd hermes-desk\nnpm ci\nnpm run dev:local",
    },
    install: {
      html: `<span class="t-prompt">$</span> npm run build
<span class="t-prompt">$</span> npm run electron:build
<span class="t-prompt">$</span> npm run install:local`,
      text: "npm run build\nnpm run electron:build\nnpm run install:local",
    },
  };

  const termTabs = $$(".term-tab");
  const termOutput = $("#term-output");
  let activeTerm = "dev";

  const selectTerm = (name, focus = false) => {
    const entry = terminal[name];
    if (!entry || !termOutput) return;
    activeTerm = name;
    termOutput.innerHTML = `<code>${entry.html}</code>`;
    termTabs.forEach((tab) => {
      const active = tab.dataset.term === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    });
    if (termOutput) {
      const activeTab = termTabs.find((tab) => tab.dataset.term === name);
      if (activeTab) termOutput.setAttribute("aria-labelledby", activeTab.id);
    }
  };

  termTabs.forEach((tab) => {
    tab.addEventListener("click", () => selectTerm(tab.dataset.term));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const index = termTabs.indexOf(tab);
      const next =
        event.key === "ArrowRight"
          ? termTabs[(index + 1) % termTabs.length]
          : termTabs[(index - 1 + termTabs.length) % termTabs.length];
      selectTerm(next.dataset.term, true);
    });
  });

  const copyButton = $(".copy-btn");
  const copyLabel = copyButton ? $("span", copyButton) : null;

  const fallbackCopy = (text) => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  };

  copyButton?.addEventListener("click", async () => {
    const text = terminal[activeTerm].text;
    let copied = false;

    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        copied = false;
      }
    }

    if (!copied) copied = fallbackCopy(text);
    if (!copied) return;

    copyButton.classList.add("is-copied");
    if (copyLabel) copyLabel.textContent = "Copied";
    window.setTimeout(() => {
      copyButton.classList.remove("is-copied");
      if (copyLabel) copyLabel.textContent = "Copy";
    }, 1800);
  });

  /* A turn, end to end ---------------------------------------------------- */
  const turnItems = $$(".turn li");
  if (turnItems.length) {
    if (reducedMotion.matches) {
      turnItems.forEach((item, index) => item.classList.toggle("is-active", index === 0));
    } else {
      let turnIndex = 0;
      let turnTimer = 0;

      const advanceTurn = () => {
        turnItems.forEach((item, index) => item.classList.toggle("is-active", index === turnIndex));
        turnIndex = (turnIndex + 1) % turnItems.length;
      };

      const turnList = $(".turn");
      const turnObserver =
        "IntersectionObserver" in window && turnList
          ? new IntersectionObserver(
              (entries) => {
                for (const entry of entries) {
                  if (entry.isIntersecting) {
                    if (!turnTimer) {
                      advanceTurn();
                      turnTimer = window.setInterval(advanceTurn, 1900);
                    }
                  } else if (turnTimer) {
                    window.clearInterval(turnTimer);
                    turnTimer = 0;
                  }
                }
              },
              { threshold: 0.35 }
            )
          : null;

      if (turnObserver) turnObserver.observe(turnList);
      else turnTimer = window.setInterval(advanceTurn, 1900);
    }
  }

  /* Footer year ----------------------------------------------------------- */
  const year = $("#year");
  if (year) year.textContent = String(new Date().getFullYear());
})();
