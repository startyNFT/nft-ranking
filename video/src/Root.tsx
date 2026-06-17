import { Composition } from "remotion";
import { TopVolume } from "./TopVolume";
import { topVolumeSchema, TopVolumeProps } from "./schema";
import data from "./_data.json";

// 1122x1122, 30fps. 6 poster frames (final state, for the Twitter card preview)
// + 156 animation frames = 162 (5.4s).
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="TopVolume"
      component={TopVolume}
      durationInFrames={162}
      fps={30}
      width={1122}
      height={1122}
      schema={topVolumeSchema}
      defaultProps={data as TopVolumeProps}
    />
  );
};
