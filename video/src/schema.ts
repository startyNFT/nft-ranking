import { z } from "zod";

export const cardSchema = z.object({
  name: z.string(),
  image: z.string(), // path relative to public/, e.g. "cards/1.jpg"
});

export const topVolumeSchema = z.object({
  title: z.string(),
  date: z.object({
    month: z.string(),
    day: z.number(),
    ordinal: z.string(),
    year: z.number(),
  }),
  cards: z.array(cardSchema).length(9),
});

export type TopVolumeProps = z.infer<typeof topVolumeSchema>;
