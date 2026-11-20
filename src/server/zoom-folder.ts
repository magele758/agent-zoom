import { z } from "zod";

// A logical path in the message list; never resolve it on the filesystem.
export const zoomFolder = z.string().trim().min(1).max(512).refine(path =>
  path.split("/").every(segment => segment.trim() === segment && segment !== "" &&
    segment !== "." && segment !== ".." && !/[\u0000-\u001f\\]/.test(segment)),
  "目录需要使用以 / 分隔的名称，例如 项目/界面");

export const opportunityProjectName = zoomFolder.pipe(z.string().max(256));
