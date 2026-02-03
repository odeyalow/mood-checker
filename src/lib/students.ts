export function studentIdFromName(name: string) {
  return encodeURIComponent(name);
}

export function studentNameFromId(id: string) {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}
