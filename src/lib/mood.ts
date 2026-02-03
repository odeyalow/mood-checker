export type MoodKind = "negative" | "neutral" | "positive";

export function classifyMood(rawMood: string): MoodKind {
  const mood = rawMood.trim().toLowerCase();

  if (
    mood.includes("нег") ||
    mood.includes("зл") ||
    mood.includes("грус") ||
    mood.includes("трев") ||
    mood.includes("раздраж") ||
    mood.includes("скук") ||
    mood.includes("испуган") ||
    mood.includes("отвращ") ||
    mood.includes("angry") ||
    mood.includes("sad") ||
    mood.includes("fear") ||
    mood.includes("disgust") ||
    mood.includes("negative")
  ) {
    return "negative";
  }

  if (
    mood.includes("поз") ||
    mood.includes("счаст") ||
    mood.includes("рад") ||
    mood.includes("happy") ||
    mood.includes("positive")
  ) {
    return "positive";
  }

  return "neutral";
}
