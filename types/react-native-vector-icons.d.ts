declare module "react-native-vector-icons" {
  import type { ComponentType } from "react";
  import type { ColorValue, TextProps } from "react-native";

  export interface IconProps extends TextProps {
    name: string;
    size?: number;
    color?: ColorValue;
  }

  const Icon: ComponentType<IconProps>;
  export default Icon;
}

declare module "react-native-vector-icons/MaterialCommunityIcons" {
  import type { ComponentType } from "react";
  import type { IconProps } from "react-native-vector-icons";

  const MaterialCommunityIcons: ComponentType<IconProps>;
  export default MaterialCommunityIcons;
}
