import type { ClientModule } from 'claude-code'

// A Client, not a Button: a Button always inverts under the pointer, and
// the API cannot turn that off. Hover here is only a brighter glyph.
type MicProps = { listening: boolean; glyph: string }
type MicState = { isHover: boolean }

const Mic: ClientModule<MicProps, MicState> = (props, surface) => {
  if (surface.state === undefined) {
    surface.onPointer(event => {
      if (event.type === 'enter') surface.setState({ isHover: true })
      else if (event.type === 'leave') surface.setState({ isHover: false })
      else if (event.type === 'down' && event.button === 'left') surface.post({ press: true })
    })
    surface.setState({ isHover: false })
  }

  const { Text } = surface.elements
  const isHover = surface.state?.isHover ?? false

  return props.listening ? (
    <Text color="red" bold={isHover}>
      {props.glyph}
    </Text>
  ) : (
    <Text dimColor={!isHover}>{props.glyph}</Text>
  )
}

export default Mic
