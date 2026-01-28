# HackerNews Fixed

A better way to read Hacker News comments. Paste a story ID or full HN URL to view its comment tree with keyboard navigation and collapsible threads.

## iOS Shortcut Setup

You can create an iOS Shortcut to open any Hacker News link directly in HN Fixed from the Share Sheet.

### Steps

1. Open **Shortcuts** app and tap **+** to create a new shortcut
2. Tap the name at the top and rename it to **Open in HN Fixed**

**Add Action 1 — Replace Text:**

1. Tap **Add Action**, search for **Replace Text**
2. Set **Find** to: `https://news.ycombinator.com/item`
3. Set **Replace with** to: `https://pnf.github.io/hnfix/` (or your deployed URL)
4. Tap the input field and choose **Shortcut Input**

**Add Action 2 — Open URLs:**

1. Tap **+** to add another action, search for **Open URLs**
2. Tap the input field and choose the **Updated Text** variable from the previous action

**Enable Share Sheet:**

1. Tap the **ⓘ** button at the bottom of the shortcut
2. Enable **Show in Share Sheet**
3. Under **Share Sheet Types**, select only **URLs**

Now when viewing a Hacker News page in Safari, tap Share and select "Open in HN Fixed" to view the comments in this app.
