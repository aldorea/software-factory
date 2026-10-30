import { BASE_IMAGE_LABEL, BASE_IMAGE_TAG, readWorkerImageFacts, workerImageState, type ImageDocker } from "../workers/images.ts";

export function workerImageMessage(image: string, state: ReturnType<typeof workerImageState>): string | null {
  switch (state) {
    case "current":
      return null;
    case "missing":
      return `${image} not built`;
    case "base-missing":
      return `the base image ${BASE_IMAGE_TAG} not built`;
    case "unlabelled":
      return `${image} has no ${BASE_IMAGE_LABEL} label, so it was built by hand`;
    case "stale":
      return `${image} built from an older base image`;
  }
}

export async function workerImageProblem(image: string | null, docker: ImageDocker): Promise<string | null> {
  if (image === null) return null;
  return workerImageMessage(image, workerImageState(await readWorkerImageFacts(image, docker)));
}
