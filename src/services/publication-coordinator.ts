/** Serializes scheduled and manual publish-next runs through durable output recording. */
export const createPublicationCoordinator = () => {
  let tail: Promise<void> = Promise.resolve();

  const runExclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };

  return { runExclusive };
};

export type PublicationCoordinator = ReturnType<typeof createPublicationCoordinator>;
