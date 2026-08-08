import { ReactNode } from "react";
import { StyleProp, StyleSheet, View, ViewStyle } from "react-native";
import LinearGradient from "react-native-linear-gradient";

type SpendSurfaceProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export default function SpendSurface({ children, style }: SpendSurfaceProps) {
  return (
    <LinearGradient
      colors={[
        "rgba(255, 255, 255, 0.12)",
        "rgba(255, 255, 255, 0.04)",
        "rgba(0, 0, 0, 0.30)",
      ]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.shell, style]}
    >
      <View style={styles.inner}>{children}</View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  shell: {
    borderRadius: 30,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 22 },
    shadowOpacity: 0.28,
    shadowRadius: 30,
    elevation: 10,
  },
  inner: {
    borderRadius: 29,
    backgroundColor: "rgba(9, 9, 12, 0.78)",
    padding: 18,
  },
});
