import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

export interface OrbitalSpinnerProps {
  size?: number;
}

export function OrbitalSpinner({ size = 24 }: OrbitalSpinnerProps): React.JSX.Element {
  const theme = useTheme();
  const rotation = useRef(new Animated.Value(0)).current;
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;

    function spin(from: number) {
      if (!alive.current) return;
      Animated.timing(rotation, {
        toValue: from + 360,
        duration: 1200,
        easing: Easing.linear,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished && alive.current) {
          rotation.setValue(from);
          spin(from);
        }
      });
    }

    spin(0);

    return () => {
      alive.current = false;
      rotation.stopAnimation();
    };
  }, [rotation]);

  const deg = rotation.interpolate({
    inputRange: [0, 360],
    outputRange: ['0deg', '360deg'],
  });

  const dotSize = Math.round(size / 4);
  const radius = (size - dotSize) / 2;
  const colors = [theme.colors.blue, theme.colors.purple, theme.colors.yellow];

  const containerStyle: ViewStyle = {
    width: size,
    height: size,
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <Animated.View style={[containerStyle, { transform: [{ rotate: deg }] }]}>
      {colors.map((color, i) => {
        const angle = (i * 2 * Math.PI) / 3;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;

        const dotStyle: ViewStyle = {
          position: 'absolute',
          width: dotSize,
          height: dotSize,
          borderRadius: dotSize / 2,
          backgroundColor: color,
          transform: [{ translateX: x }, { translateY: y }],
        };

        return <View key={i} style={dotStyle} />;
      })}
    </Animated.View>
  );
}
