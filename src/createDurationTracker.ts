function createDurationTracker() {
  const start = Date.now();
  return {
    formatDuration: () => {
      const end = Date.now();
      return ((end - start) / 1000).toFixed(2);
    },
  };
}

export { createDurationTracker };
