const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function isVisible(el) {
  // Background Chrome tabs are not painted, so offsetParent/getClientRects can be
  // empty even for real fields. Treat a connected, non-hidden node as usable.
  return el instanceof HTMLElement
    && el.isConnected
    && !el.matches('[disabled], [aria-hidden="true"], [aria-hidden="true"] *')
    && (el.offsetParent !== null || el.getClientRects().length > 0 || el.closest('form') != null);
}

function setTextInput(element, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  element.dispatchEvent(new Event("blur", { bubbles: true }));
}

// Facebook's new "Meta account" sign-up form uses obfuscated, label-less inputs
// (dynamic ids, no name/placeholder). Their stable DOM order on the sign-up page
// is: text=First name, text=Surname, text=Mobile/email, then one password input.
function signupInputs() {
  const texts = Array.from(document.querySelectorAll('input[type="text"]')).filter(isVisible);
  const password = Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible)[0] || null;
  return { firstName: texts[0] || null, lastName: texts[1] || null, email: texts[2] || null, password };
}

async function waitForSignupForm(timeout = 12_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const fields = signupInputs();
    const hasDob = Array.from(document.querySelectorAll('[role="combobox"]'))
      .some((el) => /select day/i.test(el.getAttribute("aria-label") || ""));
    if (fields.firstName && fields.lastName && fields.email && fields.password && hasDob) return fields;
    await wait(100);
  }
  throw new Error("Facebook's sign-up form did not load. Make sure you are logged OUT of Facebook (a logged-in session redirects to the feed). Nothing was submitted.");
}

// Click a Meta combobox (matched by aria-label or its visible text), then click
// the open option whose exact text matches. This is how the new date-of-birth and
// gender dropdowns are driven; there are no native <select> elements.
async function pickCombobox(labelRegex, targetText) {
  const combo = Array.from(document.querySelectorAll('[role="combobox"]'))
    .find((el) => labelRegex.test(`${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`));
  if (!(combo instanceof HTMLElement)) throw new Error(`Facebook dropdown "${targetText}" was not found.`);
  combo.click();
  await wait(450);
  const option = Array.from(document.querySelectorAll('[role="option"]'))
    .find((el) => isVisible(el) && (el.textContent || "").trim() === targetText);
  if (!(option instanceof HTMLElement)) {
    document.body.click();
    throw new Error(`Facebook dropdown option "${targetText}" was not available.`);
  }
  option.click();
  await wait(300);
}

async function fill(payload) {
  const fields = await waitForSignupForm();

  // First/Surname: the account username keeps underscores, but the name fields
  // should read as ordinary words.
  setTextInput(fields.firstName, String(payload.firstName).replace(/_/g, " "));
  setTextInput(fields.lastName, String(payload.lastName).replace(/_/g, " "));
  setTextInput(fields.email, payload.email);
  setTextInput(fields.password, payload.password);

  const monthName = MONTHS[Number(payload.month) - 1];
  if (!monthName) throw new Error("The selected birth month is invalid.");
  await pickCombobox(/select day/i, String(Number(payload.day)));
  await pickCombobox(/select month/i, monthName);
  await pickCombobox(/select year/i, String(Number(payload.year)));

  // Gender: 1 = Female, 2 = Male, 3 = Custom (default Male when unspecified).
  const genderText = payload.gender === "1" ? "Female" : payload.gender === "3" ? "Custom" : "Male";
  try {
    await pickCombobox(/select your gender|^gender$/i, genderText);
  } catch {
    // Gender is a quick manual pick if Facebook changes this control; the rest of
    // the form is still filled, so don't fail the whole action over it.
  }

  return { state: "filled" };
}

function submitButton() {
  return Array.from(document.querySelectorAll('button, [role="button"]'))
    .find((el) => isVisible(el) && /^(sign up|create account|confirm|next|continue)$/i.test((el.textContent || "").trim())) || null;
}

async function submitSignup() {
  const submit = submitButton();
  if (!submit) throw new Error("Facebook did not show a Sign Up button. Review the visible form first.");
  submit.click();
  await wait(1_250);
  return { state: "otp-required" };
}

// The background service worker retries fill-signup on every tab update, so reuse
// one in-flight fill instead of starting concurrent fills that fight over the
// obfuscated dropdowns.
let fillInFlight = null;

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.action === "fill-signup") {
    if (!fillInFlight) {
      fillInFlight = fill(message.payload).catch((error) => {
        fillInFlight = null; // allow a later retry after a failure
        throw error;
      });
    }
    fillInFlight.then(respond, (error) => respond({ state: "error", message: error instanceof Error ? error.message : "Could not fill Facebook." }));
    return true;
  }
  if (message?.action === "submit-signup") {
    submitSignup().then(respond, (error) => respond({ state: "error", message: error instanceof Error ? error.message : "Could not submit Facebook." }));
    return true;
  }
  return false;
});

// Only announce readiness once the sign-up form is actually present, so the
// background service worker does not try to fill the logged-in feed.
if (Array.from(document.querySelectorAll('[role="combobox"]')).some((el) => /select day/i.test(el.getAttribute("aria-label") || ""))
  || document.querySelector('input[type="password"]')) {
  chrome.runtime.sendMessage({ action: "signup-ready" });
}
