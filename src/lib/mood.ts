export type MoodKind = "negative" | "neutral" | "positive";

const NEGATIVE_KEYWORDS = [
  "negative",
  "angry",
  "sad",
  "fear",
  "fearful",
  "disgust",
  "disgusted",
  "\u043d\u0435\u0433",
  "\u0437\u043b",
  "\u0433\u0440\u0443\u0441",
  "\u0442\u0440\u0435\u0432",
  "\u0440\u0430\u0437\u0434\u0440\u0430\u0436",
  "\u0441\u043a\u0443\u043a",
  "\u0438\u0441\u043f\u0443\u0433",
  "\u043e\u0442\u0432\u0440\u0430\u0449",
  "\u0430\u0448\u0443",
  "\u049b\u043e\u0440\u049b",
  "\u04af\u0440\u0435\u0439",
  "\u0436\u0438\u0456\u0440\u043a\u0435\u043d",
];

const POSITIVE_KEYWORDS = [
  "positive",
  "happy",
  "\u043f\u043e\u0437",
  "\u0441\u0447\u0430\u0441\u0442",
  "\u0440\u0430\u0434",
  "\u043a\u04af\u043b\u043a\u0456",
  "\u049b\u0443\u0430\u043d",
];

export function classifyMood(rawMood: string): MoodKind {
  const mood = rawMood.trim().toLowerCase();
  if (!mood) return "neutral";

  // Paired labels like "neutral+sad" mean the two were within a few points of
  // each other. Classify by the dominant half (written first) so a near-tie is
  // not counted as fully negative just because the weaker half was.
  if (mood.includes("+")) {
    const dominant = mood.split("+")[0]?.trim();
    if (dominant) return classifyMood(dominant);
  }

  if (NEGATIVE_KEYWORDS.some((keyword) => mood.includes(keyword))) {
    return "negative";
  }

  if (POSITIVE_KEYWORDS.some((keyword) => mood.includes(keyword))) {
    return "positive";
  }

  return "neutral";
}
