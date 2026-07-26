/**
 * Simple async sleep utility.
 * @param ms - milliseconds to wait
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
