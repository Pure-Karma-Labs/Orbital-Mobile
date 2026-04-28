import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

export interface OrbitalLoaderProps {
  size?: number;
}

export function OrbitalLoader({ size = 64 }: OrbitalLoaderProps): React.JSX.Element {
  const theme = useTheme();

  const blueRot = useRef(new Animated.Value(0)).current;
  const purpleRot = useRef(new Animated.Value(120)).current;
  const yellowRot = useRef(new Animated.Value(240)).current;
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;

    function spin(anim: Animated.Value, from: number, delta: number, duration: number) {
      if (!alive.current) { return; }
      Animated.timing(anim, {
        toValue: from + delta,
        duration,
        easing: Easing.linear,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished && alive.current) {
          anim.setValue(from);
          spin(anim, from, delta, duration);
        }
      });
    }

    spin(blueRot, 0, 360, 4000);
    spin(purpleRot, 120, -360, 2000);
    spin(yellowRot, 240, -360, 7000);

    return () => {
      alive.current = false;
      blueRot.stopAnimation();
      purpleRot.stopAnimation();
      yellowRot.stopAnimation();
    };
  }, [blueRot, purpleRot, yellowRot]);

  const toDeg = (anim: Animated.Value) =>
    anim.interpolate({
      inputRange: [-240, 0, 120, 240, 360, 600],
      outputRange: ['-240deg', '0deg', '120deg', '240deg', '360deg', '600deg'],
    });

  const ringBorder = theme.colorScheme === 'dark' ? theme.colors.textPrimary : '#000';
  const dotBorder = theme.colorScheme === 'dark' ? '#fff' : '#000';
  const borderWidth = size / 32;
  const dotSize = (size / 32) * 8;
  const dotBorderWidth = size / 42;
  const armHeight = size + dotSize;

  const dots = [
    { color: theme.colors.blue, anim: blueRot },
    { color: theme.colors.purple, anim: purpleRot },
    { color: theme.colors.yellow, anim: yellowRot },
  ];

  const containerStyle: ViewStyle = {
    alignItems: 'center',
    justifyContent: 'center',
  };

  const ringStyle: ViewStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    borderWidth,
    borderColor: ringBorder,
    transform: [{ rotate: '-45deg' }, { scaleY: 0.95 }],
  };

  const armStyle: ViewStyle = {
    position: 'absolute',
    width: dotSize,
    height: armHeight,
    left: size / 2 - dotSize / 2 - borderWidth,
    top: -(borderWidth + dotSize / 2),
  };

  return (
    <View style={containerStyle}>
      <View style={ringStyle}>
        {dots.map((dot, i) => {
          const rotation = toDeg(dot.anim);

          const dotStyle: ViewStyle = {
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            backgroundColor: dot.color,
            borderWidth: dotBorderWidth,
            borderColor: dotBorder,
          };

          return (
            <Animated.View
              key={i}
              style={[armStyle, { transform: [{ rotate: rotation }] }]}
            >
              <View style={dotStyle} />
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
}
