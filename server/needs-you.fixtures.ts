// Invented questions in the shapes a fleet asks: the same decision from two bots in different words, a
// look-alike that is a different decision, and unrelated ones so rare and common words weigh as on a real install.

export interface FixtureQuestion {
  key: string;
  text: string;
  options: string[];
}

/** One decision asked in different words. */
export const DUPLICATE_CONTACTS: FixtureQuestion[] = [
  {
    key: "contacts-a",
    text: "Duplicate contacts in the Sales pipeline: Alice Moreno (deals 5a1b2c3d and 9e8f7a6b) and Bruno Tavares (7c6d5e4f and 3a2b1c0d) each have two deals. Nothing merged. Merge each pair into the deal with more history?",
    options: ["Merge both pairs, keeping the deal with more history (recommended)", "Only tell me which deals are the same case", "Leave them, I will fix it in the app"],
  },
  {
    key: "contacts-b",
    text: "CRM cleanup: 2 contacts sit in two deals each. Alice Moreno (5a1b2c3d, 9e8f7a6b) and Bruno Tavares (7c6d5e4f, 3a2b1c0d). I have not merged or deleted anything. Should I merge each pair?",
    options: ["Merge each pair, keep the most advanced deal (Recommended)", "Merge only Alice Moreno", "Do not merge anything now"],
  },
];

/** Looks alike on the surface (a stalled quote in the same pipeline) but is a different decision. */
export const STALLED_QUOTE: FixtureQuestion = {
  key: "quote",
  text: "Carla Nunes: the $4,000 quote has been stalled since July (deal 5c0d71a9, stage Quote, no next step). Where does it go?",
  options: ["Hand it to the closer (recommended)", "Move it to nurture, no follow-up now", "Leave it as is"],
};

/** Unrelated questions, so a word rare across all of them weighs more than a common one. */
export const OTHER_QUESTIONS: FixtureQuestion[] = [
  ["The carousel about testing creatives is ready up to slide 9 and stuck on slide 10. Use the new webinar art or text only?", ["New webinar art", "Text only", "Postpone the post"]],
  ["A $310.40 transfer to a fintech on 09/26 looks like a card bill for a card missing from the budget. Is the card yours?", ["It is mine: list the purchases", "It is the company's", "Ignore"]],
  ["The listings portal only turns on the integration when a shared customer asks for it. Which customer should I ask?", ["I will give you one", "You choose", "Do not ask now"]],
  ["Today's test run did not start because the only Chrome on the computer is yours. Create an isolated profile just for me?", ["Create an isolated profile", "Use your browser", "Skip the tests"]],
  ["The student answered the check-in with a voice note nobody transcribed. Who listens to it?", ["I listen and tell you", "You transcribe it", "Reply without listening"]],
  ["The new profile reached almost nobody: reach 5 on the first post and 13 views on the second. Boost it or switch the batch to Reels?", ["Organic Reels only", "Boost with a small budget", "Pause the profile"]],
  ["The strategy call calendar has no free slots and outreach stopped. Open more hours?", ["Open Monday to Friday", "Open 7 days", "Keep as is"]],
  ["The closer asked for a number-backed proof for the no-budget objection and none in the library is cleared for use. Ask the three customers?", ["Ask all 3", "Ask two", "Do not ask"]],
  ["The helpdesk invite asks to create a login on an interactive page. Should I do it for you?", ["Skip, the ticket is enough", "Open it and I will set one", "Do it yourself"]],
  ["The partner importer wants a meeting but has not shared the sandbox key yet. Build it now?", ["Do not build now", "Build it now"]],
  ["Which time should I approve for the personal profile post? The bot only publishes at an approved time.", ["Wait", "Tell me the day and hour"]],
  ["The 6pm scoreboard routine is paused, so the scoreboard misses the 8am list. Save it during the 1:50pm round instead?", ["Yes, save it", "No"]],
  ["I created a downsell task by mistake on a warm customer's deal. Delete the task?", ["Delete", "Keep"]],
  ["The downsell batch is stuck: 31 of 58 queued items wait for send approval on number 6019. Open sending?", ["Yes, open it", "Wait"]],
  ["The video tool subscription renews tomorrow for $980 on the annual plan. Renew it or switch to monthly?", ["Renew annual", "Switch to monthly", "Cancel"]],
  ["Three customers asked to export reports to a spreadsheet and the feature does not exist. Open a feature request for the product team?", ["Open a request", "Reply that it does not exist", "Wait for more requests"]],
  ["The behind-the-scenes video has copyrighted music. Replace the track or publish without sound?", ["Replace the track", "No sound", "Do not publish"]],
  ["The weekly meeting on Thursday clashes with the partner call. Move the meeting to Friday at 10am?", ["Move to Friday", "Keep Thursday"]],
  ["The hosting provider charged twice in October. Ask for a refund or a credit on the next invoice?", ["Ask for a refund", "Accept the credit"]],
  ["A customer asked to cancel within the 7-day guarantee. Refund the full amount?", ["Refund in full", "Offer a plan swap"]],
  ["The referral campaign ended with 42 signups. Repeat it next month with the same prize?", ["Repeat as is", "Change the prize", "Do not repeat"]],
  ["The weekly database backup failed twice for lack of disk space. Grow the disk by 50 GB?", ["Grow it", "Clean old files"]],
  ["The welcome guide has been outdated since the panel changed. Rewrite it now or after the launch?", ["Now", "After the launch"]],
].map(([text, options], index) => ({ key: `other-${index}`, text: text as string, options: options as string[] }));
