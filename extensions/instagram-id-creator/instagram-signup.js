const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function visible(elements) {
  // Background Chrome tabs are intentionally not painted, which makes both
  // offsetParent and getClientRects() report no layout even though Instagram's
  // inputs exist and can receive events. Check usable DOM state instead.
  return elements.find((element) => element instanceof HTMLElement
    && element.isConnected
    && !element.matches('[disabled], input[type="hidden"], [aria-hidden="true"], [aria-hidden="true"] *'));
}

function setTextInput(element, value) {
  if (element instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(element, value);
  } else if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(element, value);
  } else if (element instanceof HTMLElement && element.isContentEditable) {
    element.focus();
    element.textContent = value;
  } else {
    throw new Error('The expected Instagram input is unavailable.');
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  if (element instanceof HTMLElement) element.blur();
}

function byLabel(expression) {
  return visible(Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]')).filter((input) =>
    expression.test(`${input.getAttribute('aria-label') || ''} ${input.getAttribute('placeholder') || ''} ${input.getAttribute('name') || ''}`),
  ));
}

function bySelectors(selectors) {
  return visible(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))));
}

function combobox(label) {
  return visible(Array.from(document.querySelectorAll('[role="combobox"]')).filter((element) =>
    (element.getAttribute('aria-label') || '').toLowerCase().includes(label),
  ));
}

function selectWithKeys(control, text) {
  if (!(control instanceof HTMLElement)) throw new Error('Instagram date selector is unavailable.');
  control.click();
  for (const key of text) {
    control.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    control.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  }
  control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  control.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
}

function activeOtpInput() {
  return visible(Array.from(document.querySelectorAll('input')).filter((input) =>
    /confirmation|verification|security|code/i.test(`${input.getAttribute('aria-label') || ''} ${input.getAttribute('placeholder') || ''} ${input.getAttribute('autocomplete') || ''}`),
  ));
}

function submitButton() {
  return visible(Array.from(document.querySelectorAll('button')).filter((button) =>
    /^(submit|next|continue|confirm)$/i.test(button.textContent?.trim() || ''),
  ));
}

function signupFields() {
  const allInputs = Array.from(document.querySelectorAll('input'))
    .filter((input) => input.isConnected && input.type !== 'hidden' && !input.disabled);
  const plainTextInputs = allInputs.filter((input) => input.type === 'text' && input.getAttribute('role') !== 'combobox');
  return {
    // Instagram's current production signup form leaves the first three inputs
    // unlabelled in the DOM. Its stable order is text=email, password, text=name.
    email: bySelectors(['input[aria-label*="Mobile number or email" i]', 'input[placeholder*="Mobile number or email" i]']) || byLabel(/mobile number or email/i) || plainTextInputs[0],
    password: bySelectors(['input[aria-label="Password" i]', 'input[placeholder="Password" i]', 'input[type="password"]']) || byLabel(/^password/i),
    // Instagram currently labels this input "Name" and uses "Full name" as
    // placeholder text. Support both forms rather than treating that as a break.
    fullName: bySelectors(['input[aria-label="Name" i]', 'input[aria-label="Full name" i]', 'input[placeholder="Full name" i]']) || byLabel(/^(name|full name)/i) || plainTextInputs[1],
    username: bySelectors(['input[aria-label="Username" i]', 'input[placeholder="Username" i]', '[role="combobox"][aria-label="Username" i] input', 'input[role="combobox"]']) || byLabel(/^username/i),
  };
}

async function waitForSignupFields(timeout = 8_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const fields = signupFields();
    if (fields.email && fields.password && fields.fullName && fields.username) return fields;
    await wait(75);
  }
  const fields = signupFields();
  const missing = Object.entries(fields)
    .filter(([, field]) => !field)
    .map(([name]) => name)
    .join(', ');
  throw new Error(`Instagram sign-up fields did not load: ${missing || 'unknown field'}. Nothing was submitted.`);
}

async function fill(payload) {
  // The selectors intentionally use accessible labels rather than unstable CSS classes.
  // At document_start Instagram has not rendered them yet, so wait for the live form.
  const { email, password, fullName, username } = await waitForSignupFields();

  setTextInput(email, payload.email);
  setTextInput(password, payload.password);
  // The account username intentionally retains underscores, but Instagram's
  // display-name field should be readable as ordinary words.
  setTextInput(fullName, payload.fullName.replace(/_/g, ' '));
  setTextInput(username, payload.username);
  const monthName = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ][Number(payload.month) - 1];
  if (!monthName) throw new Error('The selected birth month is invalid.');
  selectWithKeys(combobox('select day'), payload.day);
  selectWithKeys(combobox('select month'), monthName);
  selectWithKeys(combobox('select year'), payload.year);

  const submit = submitButton();
  if (!(submit instanceof HTMLButtonElement) || submit.disabled) throw new Error('Instagram did not accept all fields. Review the visible form before submitting.');
  return { state: 'filled' };
}

async function submitSignup() {
  const submit = submitButton();
  if (!(submit instanceof HTMLButtonElement) || submit.disabled) throw new Error('Instagram has not enabled Submit. Review the visible form first.');
  submit.click();
  await wait(1_250);
  if (activeOtpInput()) return { state: 'otp-required' };
  const error = visible(Array.from(document.querySelectorAll('[role="alert"]')));
  if (error?.textContent?.trim()) throw new Error(error.textContent.trim());
  return { state: 'otp-required' };
}

async function submitOtp(payload) {
  const input = activeOtpInput();
  if (!(input instanceof HTMLInputElement)) throw new Error('Instagram is not showing a verification-code field. Check the Instagram tab.');
  setTextInput(input, payload.otp);
  const submit = submitButton();
  if (!(submit instanceof HTMLButtonElement) || submit.disabled) throw new Error('Instagram has not enabled verification. Check the code and the visible form.');
  submit.click();
  await wait(900);
  const error = visible(Array.from(document.querySelectorAll('[role="alert"]')));
  if (error?.textContent?.trim()) throw new Error(error.textContent.trim());
  return { state: 'otp-submitted' };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.action === 'fill-signup') {
    fill(message.payload).then(respond, (error) => respond({ state: 'error', message: error instanceof Error ? error.message : 'Could not fill Instagram.' }));
    return true;
  }
  if (message?.action === 'submit-signup') {
    submitSignup().then(respond, (error) => respond({ state: 'error', message: error instanceof Error ? error.message : 'Could not submit Instagram.' }));
    return true;
  }
  if (message?.action === 'submit-otp') {
    submitOtp(message.payload || {}).then(respond, (error) => respond({ state: 'error', message: error instanceof Error ? error.message : 'Could not verify Instagram.' }));
    return true;
  }
  return false;
});

// The sign-up form can be hosted in a nested document during Instagram
// experiments. Let the service worker address this exact ready frame.
chrome.runtime.sendMessage({ action: 'signup-ready' });
