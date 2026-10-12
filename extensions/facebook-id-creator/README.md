# MediaHub Facebook ID Creator

1. In the Chrome profile that opens MediaHub, visit `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this exact folder.
4. After a code update, click the extension's reload icon, then refresh `https://localhost:3443/facebook-hub?tab=creator`.

The extension only receives a form-fill request after the **Open & fill Facebook** button is clicked. It opens `https://www.facebook.com/reg/?entry_point=login`, fills the visible account-sign-up fields (first name, surname, email/mobile, password, date of birth, gender), and stops. It does not persist credentials, click Sign Up, solve challenges, or read verification codes — you review and submit the Facebook form yourself.
